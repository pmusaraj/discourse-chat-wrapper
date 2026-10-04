(() => {
  const element = (id) => document.getElementById(id);
  let timer;
  let busy = false;
  let loginVersion = 0;
  let pollTimer;
  let sessionVersion = 0;
  const sessionButtons = [];
  function setBusy(value) {
    busy = value;
    element("connect").disabled = value;
    element("address").disabled = value;
    for (const button of sessionButtons) button.disabled = value || !button.active;
  }
  async function refreshSessions(sites) {
    const version = ++sessionVersion;
    sessionButtons.length = 0;
    element("session-list").replaceChildren();
    element("sessions").hidden = !sites.length;
    await Promise.all(sites.map(async (site) => {
      const row = document.createElement("div");
      row.className = "session";
      const identity = document.createElement("div");
      identity.className = "session-identity";
      const logo = document.createElement("img");
      logo.className = "site-logo";
      logo.alt = "";
      logo.width = logo.height = 40;
      logo.referrerPolicy = "no-referrer";
      logo.addEventListener("error", () => { logo.src = "logo.svg"; }, { once: true });
      logo.src = "logo.svg";
      tiny.api.call("siteIcon", { address: site.origin }).then((url) => {
        if (typeof url === "string" && url.startsWith("https://")) logo.src = url;
      }).catch(() => {});
      const label = document.createElement("div");
      label.className = "session-label";
      label.textContent = site.name;
      const status = document.createElement("small");
      status.textContent = "Checking session…";
      label.append(status);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "open-site";
      button.ariaLabel = `Open ${site.name}`;
      button.title = `Open ${site.name}`;
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      button.disabled = true;
      sessionButtons.push(button);
      identity.append(logo, label);
      row.append(identity, button);
      element("session-list").append(row);
      button.addEventListener("click", async () => {
        if (busy || !button.active) return;
        setBusy(true);
        element("status").textContent = `Opening ${site.name}…`;
        try { await tiny.api.call("selectSite", { address: site.origin }); }
        catch (error) {
          element("add-site").open = true;
          element("address").value = site.origin;
          element("status").textContent = error.message;
          button.active = false;
          status.classList.toggle("is-active", false);
          status.textContent = "Session unavailable — authenticate again";
        } finally { setBusy(false); }
      });
      try {
        const result = await tiny.api.call("checkSession", { address: site.origin });
        if (version !== sessionVersion) return;
        button.active = result.status === "active";
        status.classList.toggle("is-active", button.active);
        button.disabled = busy || !button.active;
        status.textContent = button.active ? "Signed in" : result.status === "expired" ? "Authenticate to reconnect" : "Site unavailable — retry later";
      } catch { status.textContent = "Couldn’t check session"; }
    }));
  }
  window.__devChatLoadFailed = () => {
    resetBrowserLogin("Couldn’t load chat. Check your connection and retry.");
  };
  element("retry").addEventListener("click", () => startup());
  element("picker").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const version = ++loginVersion;
    element("connect").disabled = true;
    element("address").disabled = true;
    element("cancel-login").hidden = false;
    element("status").textContent = "Opening your browser…";
    try {
      const result = await tiny.api.call("browserLogin", { address: element("address").value });
      if (version !== loginVersion) return;
      element("device-login").hidden = result.mode !== "device";
      element("paste-login").hidden = result.mode !== "paste";
      element("device-code").textContent = result.code || "";
      element("status").textContent = result.mode === "device"
        ? `Approve sign-in to ${result.name} in your browser. This window will continue automatically.`
        : `Approve access to ${result.name} in your browser, then paste the authorization code below.`;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        resetBrowserLogin("Browser sign-in expired. Please try again.");
        await tiny.api.call("cancelBrowserLogin", {}).catch(() => {});
      }, result.expiresIn);
      if (result.mode === "device") {
        const poll = async () => {
          if (version !== loginVersion) return;
          try {
            const state = await tiny.api.call("pollBrowserLogin", {});
            if (version !== loginVersion) return;
            if (state.complete) { resetBrowserLogin("Opening chat…"); return; }
            pollTimer = setTimeout(poll, result.interval);
          } catch (error) {
            if (version === loginVersion) resetBrowserLogin(error.message || "Browser sign-in failed. Please retry.");
          }
        };
        pollTimer = setTimeout(poll, result.interval);
      }
    } catch (error) {
      if (version === loginVersion) resetBrowserLogin(error.message || "Couldn’t start browser sign-in.");
    }
  });
  function resetBrowserLogin(message) {
    loginVersion++;
    clearTimeout(timer);
    clearTimeout(pollTimer);
    element("device-login").hidden = true;
    element("paste-login").hidden = true;
    element("authorization-code").value = "";
    setBusy(false);
    element("cancel-login").hidden = true;
    element("status").textContent = message;
  }
  element("paste-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const version = loginVersion;
    element("submit-code").disabled = true;
    try {
      const state = await tiny.api.call("pasteBrowserLogin", { code: element("authorization-code").value });
      if (version === loginVersion && state.complete) resetBrowserLogin("Opening chat…");
    } catch (error) {
      if (version === loginVersion) element("status").textContent = error.message || "Couldn’t verify the code. Please retry.";
    } finally { element("submit-code").disabled = false; }
  });
  element("cancel-login").addEventListener("click", async () => {
    await tiny.api.call("cancelBrowserLogin", {});
    resetBrowserLogin("Authentication cancelled.");
  });
  async function startup() {
    try {
      const state = await tiny.api.call("startup", { url: location.href });
      element("address").value = state.address || "";
      const hasSites = !!state.sites?.length;
      element("add-site").classList.toggle("collapsible", hasSites);
      element("add-site").open = !hasSites || !!state.message;
      element("status").textContent = state.message || "";
      element("retry").hidden = true;
      await refreshSessions(state.sites || []);
    } catch {
      element("status").textContent = "Couldn’t load preferences. Please retry.";
      element("retry").hidden = false;
    }
  }
  window.addEventListener("pageshow", (event) => { if (event.persisted) startup(); });
  // Works even while WebKit suspends animation frames in a background window.
  setTimeout(startup, 100);
})();
