(() => {
  const element = (id) => document.getElementById(id);
  let timer;
  let busy = false;
  let loginVersion = 0;
  let pollTimer;
  let sessionVersion = 0;
  let lastFocus;
  let openingTimer;
  const sessionButtons = [];
  function setBusy(value) {
    busy = value;
    element("connect").disabled = value;
    element("address").disabled = value;
    for (const button of sessionButtons) button.disabled = value || !button.ready;
  }
  function showLoading(activity, detail = "") {
    const overlay = element("loading-overlay");
    const starting = overlay.hidden;
    if (starting) lastFocus = document.activeElement;
    element("loading-title").textContent = `Waiting for ${activity}`;
    element("loading-detail").textContent = detail;
    overlay.hidden = false;
    element("home-content").inert = true;
    element("title-bar").inert = true;
    if (starting) element("loading-title").focus();
  }
  function hideLoading() {
    clearTimeout(openingTimer);
    element("loading-overlay").hidden = true;
    element("home-content").inert = false;
    element("title-bar").inert = false;
    lastFocus?.focus();
  }
  function openingChat() {
    clearTimeout(timer);
    clearTimeout(pollTimer);
    loginVersion++;
    element("device-login").hidden = true;
    element("paste-login").hidden = true;
    element("authorization-code").value = "";
    element("cancel-login").hidden = true;
    element("status").textContent = "Opening chat…";
    setBusy(true);
    showLoading("chat");
    clearTimeout(openingTimer);
    openingTimer = setTimeout(() => resetBrowserLogin("Chat is taking longer than usual. Please retry."), 30000);
  }
  element("loading-overlay").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !element("cancel-login").hidden) {
      event.preventDefault();
      element("cancel-login").click();
    }
    if (event.key !== "Tab") return;
    const controls = [...element("loading-overlay").querySelectorAll("button, textarea")]
      .filter((node) => !node.disabled && node.getClientRects().length);
    const index = controls.indexOf(document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    event.preventDefault();
    (controls[next] || element("loading-title")).focus();
  });
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
      function updateSession(state) {
        button.active = state === "active";
        button.needsLogin = state === "expired";
        button.ready = button.active || button.needsLogin;
        button.disabled = busy || !button.ready;
        status.classList.toggle("is-active", button.active);
        status.textContent = button.active ? "Signed in" : button.needsLogin
          ? "Re-authenticate with this site" : "Site unavailable — retry later";
        button.className = button.needsLogin ? "login-site" : "open-site";
        button.ariaLabel = `${button.needsLogin ? "Log in to" : "Open"} ${site.name}`;
        button.title = button.ariaLabel;
        if (button.needsLogin) button.textContent = "Log in";
      }
      button.addEventListener("click", async () => {
        if (busy || !button.ready) return;
        if (button.needsLogin) {
          element("add-site").open = false;
          element("address").value = "";
          return startBrowserLogin(site.origin);
        }
        setBusy(true);
        showLoading("chat", site.name);
        element("status").textContent = `Opening ${site.name}…`;
        try {
          const selected = await tiny.api.call("selectSite", { address: site.origin });
          if (selected === false) resetBrowserLogin("");
          else openingChat();
        }
        catch (error) {
          hideLoading();
          setBusy(false);
          element("status").textContent = error.message;
          try {
            const result = await tiny.api.call("checkSession", { address: site.origin });
            if (version === sessionVersion) updateSession(result.status);
          } catch { if (version === sessionVersion) updateSession("unavailable"); }
        }
      });
      try {
        const result = await tiny.api.call("checkSession", { address: site.origin });
        if (version === sessionVersion) updateSession(result.status);
      } catch { if (version === sessionVersion) updateSession("unavailable"); }
    }));
  }
  window.__devChatSigningIn = () => {
    if (!busy) return;
    element("device-login").hidden = true;
    element("paste-login").hidden = true;
    showLoading("sign-in");
  };
  window.__devChatLoadFailed = () => {
    resetBrowserLogin("Couldn’t load chat. Check your connection and retry.");
  };
  element("retry").addEventListener("click", () => startup());
  element("picker").addEventListener("submit", async (event) => {
    event.preventDefault();
    return startBrowserLogin(element("address").value);
  });
  async function startBrowserLogin(address) {
    if (busy) return;
    setBusy(true);
    const version = ++loginVersion;
    element("connect").disabled = true;
    element("address").disabled = true;
    element("cancel-login").hidden = false;
    element("status").textContent = "Opening your browser…";
    showLoading("your browser");
    try {
      const result = await tiny.api.call("browserLogin", { address });
      if (version !== loginVersion) return;
      element("device-login").hidden = result.mode !== "device";
      element("paste-login").hidden = result.mode !== "paste";
      element("device-code").textContent = result.code || "";
      element("status").textContent = result.mode === "device"
        ? `Approve sign-in to ${result.name} in your browser. This window will continue automatically.`
        : `Approve access to ${result.name} in your browser, then paste the authorization code below.`;
      showLoading("browser approval", element("status").textContent);
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
            if (state.complete) { openingChat(); return; }
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
  }
  function resetBrowserLogin(message) {
    loginVersion++;
    clearTimeout(timer);
    clearTimeout(pollTimer);
    element("device-login").hidden = true;
    element("paste-login").hidden = true;
    element("authorization-code").value = "";
    setBusy(false);
    hideLoading();
    element("cancel-login").hidden = true;
    element("status").textContent = message;
  }
  element("paste-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const version = loginVersion;
    element("submit-code").disabled = true;
    showLoading("sign-in");
    try {
      const state = await tiny.api.call("pasteBrowserLogin", { code: element("authorization-code").value });
      if (version === loginVersion && state.complete) openingChat();
    } catch (error) {
      if (version === loginVersion) {
        element("status").textContent = error.message || "Couldn’t verify the code. Please retry.";
        showLoading("authorization code", element("status").textContent);
      }
    } finally { element("submit-code").disabled = false; }
  });
  element("cancel-login").addEventListener("click", async () => {
    try { await tiny.api.call("cancelBrowserLogin", {}); }
    finally { resetBrowserLogin("Authentication cancelled."); }
  });
  element("sessions").addEventListener("toggle", () => {
    if (element("sessions").open) element("add-site").open = false;
  });
  element("add-site").addEventListener("toggle", () => {
    if (!element("add-site").open) return;
    element("sessions").open = false;
    if (!busy) element("address").value = "";
  });
  async function startup() {
    try {
      const state = await tiny.api.call("startup", { url: location.href });
      element("address").value = "";
      element("add-site").open = false;
      element("sessions").open = !!state.sites?.length;
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
