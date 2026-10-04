import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function picker(site = null, hash = "") {
  const elements = {};
  const timers = [];
  const destinations = [];
  const element = (id) => elements[id] ??= { value: "", hidden: true, textContent: "", focus() {},
    addEventListener(name, callback) { this[name] = callback; },
    classList: { toggle() {} },
    children: [], append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; } };
  const calls = [];
  const context = { document: { getElementById: element, createElement: () => element(`node-${Object.keys(elements).length}`) },
    location: { href: "file:///app/index.html" + hash, hash, replace: (url) => destinations.push(url) },
    window: { addEventListener() {} }, clearTimeout() {}, setTimeout: (callback, delay) => timers.push({ callback, delay }),
    tiny: { win: { id: "main" }, api: { on() {}, call: async (name, payload) => { calls.push({ name, payload }); return name === "startup" ? { sites: site ? [site] : [], address: site?.origin } : { status: "active" }; } } },
  };
  vm.runInNewContext(readFileSync(new URL("../src/frontend/picker.js", import.meta.url), "utf8"), context);
  return { elements, timers, destinations, context, calls };
}

test("launch always stays on Home and checks saved sessions before enabling chat", async () => {
  const state = picker({ origin: "https://community.test", name: "community.test" });
  await state.timers[0].callback();
  assert.equal(state.destinations.length, 0);
  assert.equal(state.elements["add-site"].open, false);
  assert.equal(state.elements.address.value, "https://community.test");
  const row = state.elements["session-list"].children[0];
  assert.equal(row.children[1].disabled, false);
  assert.equal(row.children[1].ariaLabel, "Open community.test");
  await row.children[1].click();
  assert.equal(state.calls.at(-1).name, "selectSite");
});

test("expired sessions are not selectable and authentication stays available", async () => {
  const state = picker();
  state.context.tiny.api.call = async (name) => name === "startup"
    ? { sites: [{ origin: "https://community.test", name: "community.test" }] }
    : { status: "expired" };
  await state.timers[0].callback();
  const row = state.elements["session-list"].children[0];
  assert.equal(row.children[1].disabled, true);
  assert.equal(row.children[0].children[1].children[0].textContent, "Authenticate to reconnect");
  assert.equal(state.destinations.length, 0);
});

test("picker displays device code, polls sequentially and stops after cancellation", async () => {
  const state = picker();
  await state.timers[0].callback();
  const calls = [];
  state.context.tiny.api.call = async (name) => {
    calls.push(name);
    if (name === "browserLogin") return { name: "community.test", mode: "device", code: "ABCD-EFGH", interval: 5000, expiresIn: 600000 };
    return { complete: false };
  };
  await state.elements.picker.submit({ preventDefault() {} });
  assert.equal(state.elements["device-code"].textContent, "ABCD-EFGH");
  assert.equal(state.elements["device-login"].hidden, false);
  assert.equal(state.elements["paste-login"].hidden, true);
  await state.timers.find(({ delay }) => delay === 5000).callback();
  assert.equal(calls.filter((name) => name === "pollBrowserLogin").length, 1);
  await state.elements["cancel-login"].click();
  await state.timers.at(-1).callback();
  assert.equal(calls.filter((name) => name === "pollBrowserLogin").length, 1);
  assert.equal(state.elements.connect.disabled, false);
});

test("picker permits correcting a pasted code and clears it on success", async () => {
  const state = picker();
  await state.timers[0].callback();
  let fail = true;
  state.context.tiny.api.call = async (name, payload) => {
    if (name === "browserLogin") return { name: "community.test", mode: "paste", expiresIn: 600000 };
    assert.equal(name, "pasteBrowserLogin");
    assert.equal(payload.code, "encrypted-code");
    if (fail) throw new Error("Copy the complete code");
    return { complete: true };
  };
  await state.elements.picker.submit({ preventDefault() {} });
  assert.equal(state.elements["paste-login"].hidden, false);
  state.context.document.getElementById("authorization-code").value = "encrypted-code";
  await state.elements["paste-login"].submit({ preventDefault() {} });
  assert.equal(state.elements.status.textContent, "Copy the complete code");
  assert.equal(state.elements["submit-code"].disabled, false);
  fail = false;
  await state.elements["paste-login"].submit({ preventDefault() {} });
  assert.equal(state.elements["authorization-code"].value, "");
  assert.equal(state.elements.status.textContent, "Opening chat…");
});


test("new installations show the authentication form without a collapsed section", async () => {
  const state = picker();
  await state.timers[0].callback();
  assert.equal(state.elements["add-site"].open, true);
  assert.equal(state.elements.sessions.hidden, true);
});
