import { createNotifications } from "./notifications.js";
import { createNavigation, openBrowser, isAuthentication } from "./navigation.js";
import { normalizeSite, assertLocal, assertSite } from "./sites.js";
import { logoutScript } from "./logout.js";
import { createBrowserAuth, newClientId } from "./browser-auth.js";

const browserAuth = createBrowserAuth();
let site = null;
let rememberedSites = [];
let siteRevision = 0;
let initialized = Promise.resolve();
let homeMessage = "";
let lastAddress = "";
let logoutPending = false;
let logoutTimer;
let maintenance = false;
const sessionWork = new Set();
function sessionRequest(app, origin, token = "") {
  if (maintenance) throw new Error("Wait for the Dev action to finish.");
  const work = app.chatSession(origin, token);
  sessionWork.add(work);
  return work.finally(() => sessionWork.delete(work));
}
let notifications = createNotifications(null);
let navigation = createNavigation(null);

function activate(next) {
  siteRevision++;
  browserAuth.cancel();
  const enabled = notifications.enabled;
  notifications.dispose();
  site = next;
  notifications = createNotifications(next);
  notifications.setEnabled(enabled);
  navigation = createNavigation(next);
}
function home(app, message = "") {
  if (site) lastAddress = site.origin;
  homeMessage = message;
  activate(null);
  clearTimeout(logoutTimer);
  logoutPending = false;
  renderMenu(app);
  app.chatHome();
}
async function openChat(next, app, revision) {
  if (revision !== siteRevision) return false;
  if (await app.store.set("activeSite", next.origin) === false) throw new Error("Couldn’t save your site. Please retry.");
  if (revision !== siteRevision) return false;
  if (!rememberedSites.some((entry) => entry.origin === next.origin)) {
    rememberedSites.push(next);
    await app.store.set("sessionSites", rememberedSites.map((entry) => entry.origin));
    if (revision !== siteRevision) return false;
  }
  lastAddress = next.origin;
  activate(next);
  renderMenu(app);
  app.eval(`location.assign(${JSON.stringify(next.chatURL)})`);
  return true;
}
async function finishBrowserLogin(result, app, revision) {
  if (!result || revision !== siteRevision) return false;
  app.eval("window.__devChatSigningIn?.()");
  // Establish and verify the WebKit session natively; never render an OTP form.
  const session = await sessionRequest(app, result.site.origin, result.token);
  if (revision !== siteRevision) return false;
  if (session.status !== "active") throw new Error("Couldn’t establish your chat session. Please authenticate again.");
  return openChat(result.site, app, revision);
}
function savedSite(address) {
  const next = normalizeSite(address);
  if (!rememberedSites.some((entry) => entry.origin === next.origin)) throw new Error("Authenticate this site first.");
  return next;
}

export const api = {
  async startup(_payload, _app, caller) {
    assertLocal(caller);
    await initialized;
    if (site) { activate(null); renderMenu(_app); }
    return { sites: rememberedSites, address: lastAddress, message: homeMessage, notifications: notifications.enabled };
  },
  async siteIcon({ address }, _app, caller) {
    assertLocal(caller);
    await initialized;
    const next = savedSite(address);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${next.origin}/site/basic-info.json`, {
        signal: controller.signal, redirect: "error", credentials: "omit",
      });
      if (!response.ok) return null;
      const metadata = await response.json();
      const value = metadata.logo_small_url || metadata.apple_touch_icon_url || metadata.favicon_url;
      if (typeof value !== "string" || !value) return null;
      const url = new URL(value, next.origin);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  },
  async checkSession({ address }, app, caller) {
    assertLocal(caller);
    await initialized;
    const next = savedSite(address);
    return sessionRequest(app, next.origin);
  },
  async selectSite({ address }, app, caller) {
    assertLocal(caller);
    await initialized;
    const next = savedSite(address);
    if (maintenance) throw new Error("Wait for the Dev action to finish.");
    const revision = ++siteRevision;
    browserAuth.cancel();
    const result = await sessionRequest(app, next.origin);
    if (revision !== siteRevision) return false;
    if (result.status !== "active") throw new Error(result.status === "expired"
      ? "This session has expired. Authenticate to continue."
      : "Couldn’t reach this site. Check your connection and retry.");
    return openChat(next, app, revision);
  },
  async browserLogin({ address }, app, caller) {
    assertLocal(caller);
    await initialized;
    if (maintenance) throw new Error("Wait for the Dev action to finish.");
    const revision = ++siteRevision;
    browserAuth.cancel();
    let clientId = await app.store.get("browserClientId");
    if (!clientId) {
      clientId = newClientId();
      if (await app.store.set("browserClientId", clientId) === false) throw new Error("Couldn’t save authentication settings.");
    }
    if (revision !== siteRevision) throw new Error("Authentication cancelled");
    const attempt = await browserAuth.begin(address, clientId);
    if (revision !== siteRevision) throw new Error("Authentication cancelled");
    try { await app.shell.open(attempt.url); }
    catch {
      if (revision === siteRevision) browserAuth.cancel();
      throw new Error("Couldn’t open your browser. Please retry.");
    }
    return { name: attempt.site.name, mode: attempt.mode, code: attempt.code, interval: attempt.interval, expiresIn: attempt.expiresIn };
  },
  async pollBrowserLogin(_payload, app, caller) {
    assertLocal(caller);
    const revision = siteRevision;
    const result = await browserAuth.poll();
    return { complete: await finishBrowserLogin(result, app, revision) };
  },
  async pasteBrowserLogin({ code }, app, caller) {
    assertLocal(caller);
    const revision = siteRevision;
    return { complete: await finishBrowserLogin(await browserAuth.paste(code), app, revision) };
  },
  cancelBrowserLogin(_payload, _app, caller) {
    assertLocal(caller);
    siteRevision++;
    browserAuth.cancel();
    return true;
  },
  async siteContext(_payload, _app, caller) {
    await initialized;
    assertSite(site, caller);
    return site;
  },
  returnHome(_payload, app, caller) {
    assertSite(site, caller);
    home(app);
    return true;
  },
  sessionExpired(_payload, app, caller) {
    assertSite(site, caller);
    home(app, "Your session has expired. Authenticate in your browser to continue.");
    return true;
  },
  openBrowser: (payload, app, caller) => openBrowser(payload, app, caller, site),
  async logoutResult({ success }, app, caller) {
    assertSite(site, caller);
    if (!logoutPending) throw new Error("No logout in progress");
    clearTimeout(logoutTimer);
    logoutPending = false;
    if (!success) { home(app, "Logout failed. Your session has been kept; you can retry from chat."); return false; }
    await app.store.set("sessionSites", rememberedSites.map((entry) => entry.origin));
    await app.store.set("activeSite", null);
    home(app, "You’re signed out.");
    return true;
  },
  chatAlert: (payload, app, caller) => notifications.receive(payload, app, caller),
  async chatListenerReady({ ready }, app, caller) {
    assertSite(site, caller);
    notifications.setReady(ready);
    if (ready && !rememberedSites.some((entry) => entry.origin === site.origin)) {
      rememberedSites.push(site);
      await app.store.set("sessionSites", rememberedSites.map((entry) => entry.origin));
    }
    return true;
  },
};

export async function init(app) {
  initialized = (async () => {
    activate(null);
    rememberedSites = [];
    homeMessage = "";
    lastAddress = await app.store.get("activeSite") || "";
    const saved = await app.store.get("sessionSites");
    // Include pre-picker installations for a live session check, never auto-open.
    for (const address of [...(Array.isArray(saved) ? saved : []), ...(lastAddress ? [lastAddress] : [])]) {
      try {
        const next = normalizeSite(address);
        if (!rememberedSites.some((entry) => entry.origin === next.origin)) rememberedSites.push(next);
      } catch {}
    }
    notifications.setEnabled((await app.store.get("desktopNotifications")) !== false);
  })();
  await initialized;
  renderMenu(app);
}
function renderMenu(app) {
  app.setMenu([{ role: "edit" }, { title: "Chat", items: [
    { id: "home", label: "Home", key: "1" },
    { id: "reload", label: "Reload", key: "r" },
    { separator: true },
    { id: "browser", label: "Open Chat in Browser", enabled: !!site },
    { id: "logout", label: "Log Out", enabled: !!site && !logoutPending && !maintenance },
    { separator: true },
    { id: "notifications", label: "Desktop Notifications", checked: notifications.enabled },
  ] }, { title: "Dev", items: [
    { id: "dev-remove-all", label: "Remove All Sessions and Sites", enabled: !maintenance && !logoutPending },
    { id: "dev-logout-all", label: "Log Out All Sites", enabled: !!rememberedSites.length && !maintenance && !logoutPending },
    { id: "dev-logout-current", label: "Log Out Current Site", enabled: !!site && !maintenance && !logoutPending },
    { separator: true },
    { id: "dev-test-notification", label: "Test Notification in 5 Seconds" },
  ] }]);
}
export async function onMenu(id, app) {
  if (id === "notifications") {
    notifications.setEnabled(!notifications.enabled);
    await app.store.set("desktopNotifications", notifications.enabled);
    renderMenu(app);
    if (notifications.enabled) await app.permissions.request("notifications");
  }
  if (id === "dev-test-notification") {
    await app.permissions.request("notifications");
    setTimeout(() => app.notify({ id: `dev-test-${Date.now()}`, title: "Discourse Chat App",
      body: "Desktop notifications are working.", sound: true }), 5000);
  }
  if (["dev-remove-all", "dev-logout-all", "dev-logout-current"].includes(id)) {
    if (maintenance || logoutPending) return;
    const targets = id === "dev-logout-current" ? (site ? [site] : []) : [...rememberedSites];
    maintenance = true;
    siteRevision++;
    browserAuth.cancel();
    // Stop the remote page before touching cookies, then drain native checks so
    // an in-flight cookie rotation cannot restore a session after removal.
    home(app, "Updating sessions…");
    try {
      await Promise.allSettled([...sessionWork]);
      if (id === "dev-remove-all") {
        const result = await app.chatClearSessions();
        if (!result.ok) throw new Error("Couldn’t remove local sessions.");
        if (await app.store.set("sessionSites", []) === false || await app.store.set("activeSite", null) === false) {
          throw new Error("Sessions cleared, but couldn’t save the site list. Please retry.");
        }
        rememberedSites = [];
        lastAddress = "";
        homeMessage = "All local sessions and sites removed.";
      } else {
        const failures = [];
        for (const target of targets) {
          try {
            const result = await app.chatSession(target.origin, "", "logout");
            if (result.status !== "logged-out") failures.push(target.name);
          } catch { failures.push(target.name); }
        }
        homeMessage = failures.length ? `Couldn’t log out: ${failures.join(", ")}. You can retry from Dev.`
          : "Signed out. Your sites are still saved.";
      }
    } catch (error) { homeMessage = error.message || "The Dev action failed. Please retry."; }
    finally { maintenance = false; home(app, homeMessage); }
    return;
  }
  if (id === "home") home(app);
  if (id === "reload") app.reload();
  if (id === "browser" && site) await app.shell.open(site.chatURL);
  if (id === "logout" && site && !logoutPending) {
    logoutPending = true;
    renderMenu(app);
    app.eval(logoutScript(site.origin));
    logoutTimer = setTimeout(() => home(app, "Logout did not finish. Your session has been kept."), 20000);
  }
}
export function onNotificationClick(id, app) { notifications.click(id, app); }
export function onWindowOpen({ kind }) { if (kind === "policy") return "external"; }
export function onNavigate({ kind, url, window: windowId = "main" }, app) {
  if (windowId !== "main") return kind === "policy" ? "deny" : undefined;
  if (kind === "policy") {
    let target;
    try { target = new URL(url); } catch { return "deny"; }
    if (site && isAuthentication(target, site)) {
      home(app, "Authenticate in your browser to continue.");
      return "deny";
    }
    return navigation.policy(url);
  }
  if (kind === "commit") {
    app.setChrome({ frame: false, windowControls: true, vibrancy: null, windowControlsPos: { x: 18, y: 17 } });
  }
  if (kind === "start") {
    notifications.setReady(false);
    app.setTitle("Discourse Chat App — Loading…");
  }
  if (kind === "finish") app.setTitle("Discourse Chat App");
  if (kind === "fail" || kind === "crash") {
    // Ignore cancellation/failure events from the document we just left for Home.
    if (site && (kind === "crash" || url?.startsWith(site.origin + "/"))) {
      home(app, "Couldn’t load chat. Check your connection and try again.");
    }
  }
}
