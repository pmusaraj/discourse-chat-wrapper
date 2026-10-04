import assert from "node:assert/strict";
import test from "node:test";
import { chatDestination, createNotifications } from "../src/notifications.js";

const ORIGIN = "https://dev.discourse.org";
const site = { origin: ORIGIN };
const caller = { origin: ORIGIN, window: "main" };
const payload = { messageId: 42, title: "Alice mentioned you", body: "Hello!", url: "/chat/c/general/1/42" };
function mockApp({ focused = false, bundleId = "other.app" } = {}) {
  const sent = [], scripts = [];
  return {
    sent, scripts,
    getWinState: async () => ({ focused }),
    frontmostApp: async () => ({ bundleId }),
    notify: async (value) => { sent.push(value); return true; },
    restore() { this.restored = true; },
    show() { this.shown = true; },
    eval(value) { scripts.push(value); },
  };
}

test("only background chat alerts are delivered, even with concurrent duplicates", async () => {
  const service = createNotifications(site);
  const app = mockApp();
  const results = await Promise.all([service.receive(payload, app, caller), service.receive(payload, app, caller)]);
  assert.deepEqual(results, [{ delivered: true }, { delivered: false, reason: "duplicate" }]);
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].body, "Hello!");
  assert.equal(app.sent[0].sound, true);
  service.click(app.sent[0].id, app);
  assert.equal(app.shown, true);
  assert.equal(app.restored, true);
  assert.equal(app.scripts[0], `location.href = ${JSON.stringify(ORIGIN + payload.url)}`);
});

test("focus suppresses alerts and they are not replayed later", async () => {
  const service = createNotifications(site);
  const app = mockApp({ focused: true });
  assert.equal((await service.receive(payload, app, caller)).reason, "focused");
  app.getWinState = async () => ({ focused: false });
  assert.equal((await service.receive(payload, app, caller)).reason, "duplicate");
  assert.equal(app.sent.length, 0);
});

test("an active app popup, disabled preference, and unknown focus suppress delivery", async () => {
  assert.equal((await createNotifications(site).receive(payload,
    mockApp({ bundleId: "org.discourse.dev.chat.tinyjs.poc" }), caller)).reason, "focused");
  const service = createNotifications(site);
  service.setEnabled(false);
  assert.equal((await service.receive(payload, mockApp(), caller)).reason, "disabled");
  const app = mockApp();
  app.getWinState = async () => null;
  assert.equal((await createNotifications(site).receive(payload, app, caller)).reason, "unknown-focus");
});

test("untrusted origins/windows and non-chat destinations cannot send notifications", async () => {
  const service = createNotifications(site);
  const app = mockApp();
  assert.throws(() => service.receive(payload, app, { ...caller, origin: "https://evil.test" }));
  assert.throws(() => service.receive(payload, app, { ...caller, window: "popup1" }));
  for (const url of ["https://evil.test/chat/", "//evil.test/chat/", "javascript:alert(1)", "/admin", "/chatty", "/chat/../../admin"]) {
    assert.equal(chatDestination(url, site), null);
    assert.equal((await service.receive({ ...payload, url }, app, caller)).reason, "invalid");
  }
  assert.equal(chatDestination("/chat/channel/1/thread/2", site), ORIGIN + "/chat/channel/1/thread/2");
  assert.equal(app.sent.length, 0);
  service.click("unknown-id", app);
  assert.equal(app.scripts.length, 0);
});

test("malformed messages are ignored and text lengths are bounded", async () => {
  const service = createNotifications(site);
  const app = mockApp();
  assert.equal((await service.receive({ ...payload, messageId: -1 }, app, caller)).reason, "invalid");
  await service.receive({ ...payload, title: "x".repeat(1000), body: "y".repeat(1000) }, app, caller);
  assert.equal(app.sent[0].title.length, 160);
  assert.equal(app.sent[0].body.length, 500);
});

test("disposing a site's listener suppresses queued alerts and old notification clicks", async () => {
  const service = createNotifications(site);
  const app = mockApp();
  let finishFocus;
  app.getWinState = () => new Promise((resolve) => { finishFocus = resolve; });
  const pending = service.receive(payload, app, caller);
  await Promise.resolve();
  service.dispose();
  finishFocus({ focused: false });
  assert.equal((await pending).reason, "inactive-site");
  assert.equal(app.sent.length, 0);
});
