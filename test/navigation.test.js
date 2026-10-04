import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { onNavigate, onWindowOpen } from "../src/main.js";
import { createNavigation, openBrowser } from "../src/navigation.js";
const site = { origin: "https://dev.discourse.org" };

test("only chat is internal; login pages are denied and external links use the browser", () => {
  const navigation = createNavigation(site);
  for (const path of ["/chat", "/chat/", "/chat/c/general/1?foo=bar"]) {
    assert.equal(navigation.policy(site.origin + path), undefined);
  }
  for (const path of ["/login", "/login-required", "/session/otp/123", "/auth/sso", "/signup"]) {
    assert.equal(navigation.policy(site.origin + path), "deny");
  }
  for (const url of ["https://example.com/chat", site.origin + "/t/topic/1", "https://identity.example.com/authorize"]) {
    assert.equal(navigation.policy(url), "external");
  }
  assert.equal(onWindowOpen({ kind: "policy", url: site.origin + "/login" }), "external");
});

test("navigation policy rejects local files and executable URL schemes", () => {
  for (const url of ["file:///etc/hosts", "javascript:alert(1)", "data:text/html,test", "invalid"]) {
    assert.equal(onNavigate({ kind: "policy", url }), "deny");
  }
});

test("session operations are only exposed to the local main webview", () => {
  const config = JSON.parse(readFileSync(new URL("../tinyjs.json", import.meta.url)));
  const remote = config.api.origins["https://*"];
  for (const name of ["startup", "selectSite", "checkSession", "browserLogin", "pasteBrowserLogin", "pollBrowserLogin"]) {
    assert.ok(!remote.includes(name));
    assert.ok(config.api.origins["file://*"].includes(name));
  }
  assert.ok(remote.includes("sessionExpired"));
  assert.ok(remote.includes("returnHome"));
  assert.equal(config.popups, "external");
});

test("browser bridge only opens web URLs from the trusted main window", async () => {
  const opened = [];
  const app = { shell: { open: async (url) => opened.push(url) } };
  const caller = { origin: site.origin, window: "main" };
  await openBrowser({ url: "https://example.com/test" }, app, caller, site);
  assert.deepEqual(opened, ["https://example.com/test"]);
  for (const url of ["file:///etc/hosts", "javascript:alert(1)", "https://user:password@example.com"]) {
    assert.throws(() => openBrowser({ url }, app, caller, site));
  }
  assert.throws(() => openBrowser({ url: "https://example.com" }, app, { ...caller, window: "popup" }, site));
  assert.throws(() => openBrowser({ url: "https://example.com" }, app, { ...caller, origin: "https://evil.example" }, site));
});
