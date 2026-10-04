import test from "node:test";
import assert from "node:assert/strict";
import { publicEncrypt, constants } from "node:crypto";
import { createBrowserAuth, AUTH_REDIRECT } from "../src/browser-auth.js";

const encrypt = (key, value) => publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: "sha1" }, Buffer.from(value)).toString("base64");
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function server({ device = false } = {}) {
  const state = { requests: [], params: null, status: "authorization_pending", now: 0 };
  state.payload = (overrides = {}) => encrypt(state.params.public_key, JSON.stringify({
    key: "a".repeat(32), api: 4, nonce: state.params.nonce, ...overrides,
  }));
  state.request = async (url, options) => {
    state.requests.push({ url, options });
    if (options.method === "HEAD") return new Response(null, {
      headers: device ? { "Auth-Api-Device-Code": "true" } : {},
    });
    if (url.endsWith("/device.json")) {
      state.params = JSON.parse(options.body);
      return json({ device_code: "d".repeat(64), user_code: "ABCD-EFGH", interval: 5, expires_in: 600,
        verification_uri_with_request: "https://community.test/user-api-key/activate?request=abcdefgh",
        ...state.deviceOverrides });
    }
    if (url.endsWith("/poll.json")) {
      if (state.pollGate) await state.pollGate;
      return json({ status: state.status, ...(state.status === "authorized" ? { payload: state.payload() } : {}) }, state.pollStatus || 200);
    }
    if (url.endsWith("/otp.json")) {
      if (state.otpGate) await state.otpGate;
      if (state.otpFailure) return json({}, 403);
      const redirect = new URL(AUTH_REDIRECT);
      redirect.searchParams.set("oneTimePassword", encrypt(state.params.public_key, "b".repeat(32)));
      return json({ redirect_url: state.redirect || redirect.href });
    }
    if (url.endsWith("/revoke")) return json({});
    throw new Error("Unexpected request");
  };
  state.auth = createBrowserAuth({ now: () => state.now, request: state.request });
  state.begin = async () => {
    const result = await state.auth.begin("community.test", "client-test");
    if (!device) state.params = Object.fromEntries(new URL(result.url).searchParams);
    return result;
  };
  return state;
}

test("paste flow has no callback, exchanges the encrypted key for an OTP, and revokes it", async () => {
  const s = server();
  const attempt = await s.begin();
  assert.equal(attempt.mode, "paste");
  assert.equal(s.params.auth_redirect, undefined);
  assert.equal(s.params.scopes, "write");
  assert.equal(s.params.padding, "oaep");
  const result = await s.auth.paste(s.payload());
  assert.equal(result.token, "b".repeat(32));
  assert.equal(result.site.origin, "https://community.test");
  assert.equal(result.apiKey, undefined);
  const [otp, revoke] = s.requests.slice(-2);
  assert.ok(otp.url.endsWith("/otp.json"));
  assert.equal(JSON.parse(otp.options.body).auth_redirect, AUTH_REDIRECT);
  assert.ok(revoke.url.endsWith("/revoke"));
  for (const request of [otp, revoke]) {
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.headers["User-Api-Key"], "a".repeat(32));
    assert.equal(request.options.headers["User-Api-Client-Id"], "client-test");
  }
  await assert.rejects(s.auth.paste(s.payload()), /Start browser/);
});

test("malformed and mismatched pasted codes can be corrected without network exchanges", async () => {
  const s = server();
  await s.begin();
  await assert.rejects(s.auth.paste("bad"), /verify/);
  await assert.rejects(s.auth.paste(s.payload({ nonce: "wrong" })), /didn’t match/);
  assert.equal(s.requests.length, 1);
  const results = await Promise.all([s.auth.paste(s.payload()), s.auth.paste(s.payload())]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("device flow respects the interval and polls until approval before exchanging the key", async () => {
  const s = server({ device: true });
  const attempt = await s.begin();
  assert.equal(attempt.mode, "device");
  assert.equal(attempt.code, "ABCD-EFGH");
  assert.equal(s.params.scopes, "write");
  assert.equal(await s.auth.poll(), null);
  assert.equal(s.requests.length, 2);
  s.now = 5000;
  assert.equal(await s.auth.poll(), null);
  s.status = "authorized";
  s.now = 10000;
  const result = await s.auth.poll();
  assert.equal(result.token, "b".repeat(32));
  assert.equal(await s.auth.poll(), null);
  const poll = s.requests.find(({ url }) => url.endsWith("/poll.json"));
  assert.equal(JSON.parse(poll.options.body).device_code, "d".repeat(64));
});

test("denial, expiry, and cancellation stop authorization", async () => {
  for (const status of ["access_denied", "expired_token"]) {
    const s = server({ device: true });
    await s.begin();
    s.status = status;
    s.now = 5000;
    await assert.rejects(s.auth.poll(), /denied|expired/);
    assert.equal(await s.auth.poll(), null);
  }
  const s = server();
  await s.begin();
  s.now = 600001;
  await assert.rejects(s.auth.paste(s.payload()), /expired/);
  await s.begin();
  s.auth.cancel();
  await assert.rejects(s.auth.paste(s.payload()), /Start browser/);
});

test("rate limiting backs off; simultaneous polls do not duplicate requests", async () => {
  const s = server({ device: true });
  await s.begin();
  s.now = 5000;
  s.pollStatus = 429;
  await Promise.all([s.auth.poll(), s.auth.poll()]);
  assert.equal(s.requests.length, 3);
  s.now = 10000;
  await s.auth.poll();
  assert.equal(s.requests.length, 3);
  s.now = 15000;
  s.pollStatus = 200;
  await s.auth.poll();
  assert.equal(s.requests.length, 4);
});

test("failed OTP exchange and unexpected redirect revoke the key without navigating", async () => {
  for (const failure of ["otpFailure", "redirect"]) {
    const s = server();
    await s.begin();
    s[failure] = failure === "redirect" ? "https://other.test/?oneTimePassword=bad" : true;
    await assert.rejects(s.auth.paste(s.payload()), /session|Invalid/);
    assert.ok(s.requests.at(-1).url.endsWith("/revoke"));
    assert.equal(s.auth.waiting, false);
  }
});

test("cancellation during the OTP exchange suppresses login and still revokes the key", async () => {
  const s = server();
  await s.begin();
  let release;
  s.otpGate = new Promise((resolve) => { release = resolve; });
  const result = s.auth.paste(s.payload());
  while (!s.requests.some(({ url }) => url.endsWith("/otp.json"))) await new Promise(setImmediate);
  s.auth.cancel();
  release();
  assert.equal(await result, null);
  assert.ok(s.requests.at(-1).url.endsWith("/revoke"));
});

test("device approval URLs cannot point to another site", async () => {
  const s = server({ device: true });
  s.deviceOverrides = { verification_uri_with_request: "https://other.test/user-api-key/activate" };
  await assert.rejects(s.begin(), /Invalid device/);
});

test("native paste handoff is local-only, saves no credentials and returns to chat", async (t) => {
  const { api, init } = await import("../src/main.js");
  const s = server();
  t.mock.method(globalThis, "fetch", s.request);
  const values = new Map(), scripts = [], opened = [];
  const app = {
    store: { get: async (key) => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); return true; } },
    permissions: { check: async () => "granted" }, setMenu() {}, setTitle() {}, setChrome() {},
    windows: async () => ["main"], restore() {}, show() {},
    chatSession: async (origin, token) => { assert.equal(origin, "https://community.test"); assert.equal(token, "b".repeat(32)); return { status: "active" }; },
    shell: { open: async (url) => opened.push(url) },
    eval: (script) => scripts.push(script), window: () => ({ push() {} }),
  };
  await init(app);
  const caller = { origin: "file://", window: "main" };
  const result = await api.browserLogin({ address: "community.test" }, app, caller);
  assert.equal(result.mode, "paste");
  s.params = Object.fromEntries(new URL(opened[0]).searchParams);
  for (const method of ["pasteBrowserLogin", "pollBrowserLogin"]) {
    await assert.rejects(api[method]({ code: s.payload() }, app, { origin: "https://community.test", window: "main" }));
    await assert.rejects(api[method]({ code: s.payload() }, app, { origin: "file://", window: "site-picker" }));
  }
  assert.deepEqual(await api.pasteBrowserLogin({ code: s.payload() }, app, caller), { complete: true });
  assert.equal(scripts.at(-1), 'location.assign("https://community.test/chat/")');
  assert.equal(values.get("activeSite"), "https://community.test");
  assert.ok(scripts.every((script) => !script.includes("/session/otp/")));
  assert.ok([...values.values()].every((value) => !String(value).includes("a".repeat(32))));
});

test("a superseded paste cannot authorize the new attempt", async () => {
  const s = server();
  await s.begin();
  const oldPayload = s.payload();
  await s.begin();
  await assert.rejects(s.auth.paste(oldPayload), /verify/);
  assert.equal((await s.auth.paste(s.payload())).token, "b".repeat(32));
});

test("cancelling capability detection prevents a late browser URL from being returned", async () => {
  let release, requested;
  const started = new Promise((resolve) => { requested = resolve; });
  const auth = createBrowserAuth({ request: async () => {
    requested();
    await new Promise((resolve) => { release = resolve; });
    return new Response(null);
  } });
  const attempt = auth.begin("community.test", "client-test");
  await started;
  auth.cancel();
  release();
  await assert.rejects(attempt, /cancelled/);
  assert.equal(auth.waiting, false);
});
