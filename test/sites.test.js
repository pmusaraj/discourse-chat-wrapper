import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSite } from "../src/sites.js";
import { api, init, onMenu, onNavigate } from "../src/main.js";
const local = { origin: "file://", window: "main" };
const caller = { origin: "https://community.test", window: "main" };
function mockApp() {
  const values = new Map([["activeSite", caller.origin], ["sessionSites", [caller.origin, "https://second.test"]]]);
  return { values, scripts: [], homeCount: 0, status: "active",
    store: { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); return true; } },
    permissions: { check: async () => "granted" },
    setMenu(menu) { this.menu = menu; }, setTitle() {}, setChrome() {},
    chatHome() { this.homeCount++; }, async chatSession() { return { status: this.status }; },
    eval(script) { this.scripts.push(script); },
  };
}
test("site normalization accepts hosts and rejects unsupported addresses", () => {
  assert.equal(normalizeSite(" COMMUNITY.test ").origin, caller.origin);
  for (const url of ["", "http://community.test", "file:///etc/hosts", "https://user:pass@community.test", "https://community.test/forum"]) assert.throws(() => normalizeSite(url));
});
test("startup lists saved sites without selecting one; only verified sessions can open", async () => {
  const app = mockApp();
  await init(app);
  const state = await api.startup({}, app, local);
  assert.equal(state.sites.length, 2);
  assert.equal(app.scripts.length, 0);
  await assert.rejects(api.siteContext({}, app, caller));
  await assert.rejects(api.selectSite({ address: caller.origin }, app, caller));
  await assert.rejects(api.selectSite({ address: "unknown.test" }, app, local), /Authenticate/);
  app.status = "expired";
  await assert.rejects(api.selectSite({ address: caller.origin }, app, local), /expired/);
  assert.equal(app.scripts.length, 0);
  app.status = "active";
  await api.selectSite({ address: caller.origin }, app, local);
  assert.match(app.scripts.at(-1), /location.assign/);
  assert.equal((await api.siteContext({}, app, caller)).origin, caller.origin);
});
test("Home returns the same webview to intro and preserves sessions; Sites menu is absent", async () => {
  const app = mockApp();
  await init(app);
  await api.selectSite({ address: caller.origin }, app, local);
  await onMenu("home", app);
  assert.equal(app.homeCount, 1);
  assert.equal(app.values.get("sessionSites").length, 2);
  assert.equal(app.menu.some((entry) => entry.title === "Sites"), false);
  await assert.rejects(api.siteContext({}, app, caller));
});
test("login redirects are cancelled and expired sessions return to intro", async () => {
  const app = mockApp();
  await init(app);
  await api.selectSite({ address: caller.origin }, app, local);
  assert.equal(onNavigate({ kind: "policy", url: caller.origin + "/login" }, app), "deny");
  assert.equal(app.homeCount, 1);
  assert.match((await api.startup({}, app, local)).message, /Authenticate/);
});
test("late session checks cannot open chat after returning Home", async () => {
  const app = mockApp();
  await init(app);
  let release;
  app.chatSession = () => new Promise((resolve) => { release = resolve; });
  const selecting = api.selectSite({ address: caller.origin }, app, local);
  await new Promise(setImmediate);
  await onMenu("home", app);
  release({ status: "active" });
  assert.equal(await selecting, false);
  assert.equal(app.scripts.length, 0);
});
test("successful logout removes the saved session and returns Home", async () => {
  const app = mockApp();
  await init(app);
  await api.selectSite({ address: caller.origin }, app, local);
  await onMenu("logout", app);
  await api.logoutResult({ success: true }, app, caller);
  assert.equal(app.homeCount, 1);
  assert.deepEqual(app.values.get("sessionSites"), ["https://second.test"]);
});


test("desktop notifications live in the menu and persist when toggled", async () => {
  const app = mockApp();
  await init(app);
  await onMenu("notifications", app);
  assert.equal(app.values.get("desktopNotifications"), false);
  const item = app.menu.find((entry) => entry.title === "Chat").items.find((entry) => entry.id === "notifications");
  assert.equal(item.checked, false);
});

test("Dev remove-all clears native website data and prevents saved sites returning", async () => {
  const app = mockApp();
  let cleared = false;
  app.chatClearSessions = async () => { cleared = true; return { ok: true }; };
  await init(app);
  await onMenu("dev-remove-all", app);
  assert.equal(cleared, true);
  assert.deepEqual(app.values.get("sessionSites"), []);
  assert.equal(app.values.get("activeSite"), null);
  await init(app);
  assert.equal((await api.startup({}, app, local)).sites.length, 0);
});

test("Dev logout-all preserves sites and reports partial failures", async () => {
  const app = mockApp();
  const loggedOut = [];
  app.chatSession = async (origin, token, operation) => {
    assert.equal(operation, "logout");
    loggedOut.push(origin);
    return { status: origin === caller.origin ? "logged-out" : "unavailable" };
  };
  await init(app);
  await onMenu("dev-logout-all", app);
  assert.deepEqual(loggedOut, [caller.origin, "https://second.test"]);
  const state = await api.startup({}, app, local);
  assert.equal(state.sites.length, 2);
  assert.match(state.message, /second.test/);
});

test("Dev reset drains pending cookie checks before clearing native sessions", async () => {
  const app = mockApp();
  let release;
  let cleared = false;
  app.chatSession = () => new Promise((resolve) => { release = resolve; });
  app.chatClearSessions = async () => { cleared = true; return { ok: true }; };
  await init(app);
  const check = api.checkSession({ address: caller.origin }, app, local);
  await new Promise(setImmediate);
  const reset = onMenu("dev-remove-all", app);
  await new Promise(setImmediate);
  assert.equal(cleared, false);
  await assert.rejects(api.browserLogin({ address: caller.origin }, app, local), /Dev action/);
  release({ status: "active" });
  await Promise.all([check, reset]);
  assert.equal(cleared, true);
});

test("Dev logout-current targets only the open site and keeps saved sites", async () => {
  const app = mockApp();
  await init(app);
  await api.selectSite({ address: caller.origin }, app, local);
  const targets = [];
  app.chatSession = async (origin, token, operation) => {
    targets.push({ origin, operation });
    return { status: "logged-out" };
  };
  await onMenu("dev-logout-current", app);
  assert.deepEqual(targets, [{ origin: caller.origin, operation: "logout" }]);
  assert.equal((await api.startup({}, app, local)).sites.length, 2);
});

test("Dev notification test works from Home after a five-second delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = mockApp();
  const sent = [];
  app.permissions.request = async () => "granted";
  app.notify = async (payload) => { sent.push(payload); return true; };
  await init(app);
  await onMenu("dev-test-notification", app);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(5000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Discourse Chat");
});
