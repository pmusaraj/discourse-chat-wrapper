import { normalizeSite } from "./sites.js";

export const AUTH_REDIRECT = "discourse://auth_redirect";
const TTL = 10 * 60 * 1000;
const encode = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
function decode(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid login response");
  return Uint8Array.from(atob(value.replace(/\s/g, "")), (char) => char.charCodeAt(0));
}
const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((v) => v.toString(16).padStart(2, "0")).join("");

// No credentials or pending login URLs are persisted. A restart requires a
// fresh browser login; WebKit's established sessions still survive normally.
export function createBrowserAuth({ now = Date.now, request = (...args) => fetch(...args) } = {}) {
  let pending;
  let generation = 0;
  async function send(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await request(url, { ...options, redirect: "error", signal: controller.signal });
    } catch { throw new Error("Couldn’t contact the site. Please retry browser sign-in."); }
    finally { clearTimeout(timer); }
  }
  const post = (attempt, path, body, key) => send(attempt.site.origin + path, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json",
      ...(key ? { "User-Api-Key": key, "User-Api-Client-Id": attempt.clientId } : {}) },
    body: JSON.stringify(body),
  });
  function current() {
    if (pending && now() >= pending.expires) {
      pending = null;
      throw new Error("Login expired. Start browser sign-in again.");
    }
    return pending;
  }
  const decrypt = async (attempt, value) => new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "RSA-OAEP" }, attempt.privateKey, decode(value)));
  async function exchange(value, attempt) {
    if (!attempt || attempt.busy) return null;
    attempt.busy = true;
    let key;
    try {
      let payload;
      try { payload = JSON.parse(await decrypt(attempt, value)); }
      catch { throw new Error("Couldn’t verify the authorization code. Copy the complete code or restart browser sign-in."); }
      if (!payload || payload.nonce !== attempt.nonce || !Number.isInteger(payload.api) || payload.api < 4 ||
          typeof payload.key !== "string" || !/^[a-f0-9]{32,128}$/i.test(payload.key)) {
        throw new Error("The login response didn’t match this sign-in attempt.");
      }
      key = payload.key;
      if (current() !== attempt) return null;
      const response = await post(attempt, "/user-api-key/otp.json", {
        public_key: attempt.publicKey, application_name: "Discourse Chat Wrapper",
        auth_redirect: AUTH_REDIRECT, padding: "oaep",
      }, key);
      if (!response.ok) throw new Error("The site couldn’t create a chat session. Start browser sign-in again.");
      const data = await response.json();
      const redirect = new URL(data.redirect_url);
      if (redirect.protocol !== "discourse:" ||
          redirect.hostname !== "auth_redirect" || redirect.pathname || redirect.hash || redirect.username ||
          redirect.password || redirect.port || redirect.searchParams.getAll("oneTimePassword").length !== 1) {
        throw new Error("Invalid chat login response.");
      }
      const token = await decrypt(attempt, redirect.searchParams.get("oneTimePassword"));
      if (!/^[a-f0-9]{32}$/i.test(token)) throw new Error("Invalid chat login token.");
      if (current() !== attempt) return null;
      pending = null;
      return { site: attempt.site, token, clientId: attempt.clientId, windowId: attempt.windowId };
    } finally {
      attempt.busy = false;
      if (key) {
        if (pending === attempt) pending = null;
        try {
          const response = await post(attempt, "/user-api-key/revoke", {}, key);
          if (!response.ok) throw new Error();
        } catch { console.warn("Temporary login key could not be revoked; remove it in the site’s Apps preferences."); }
      }
    }
  }
  return {
    cancel() { generation++; pending = null; },
    get waiting() { return !!pending && now() < pending.expires; },
    async begin(address, clientId, windowId = "main") {
      const version = ++generation;
      pending = null;
      const site = normalizeSite(address);
      // Discourse's OAEP mode uses OpenSSL's SHA-1 OAEP/MGF1 defaults.
      const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
      if (version !== generation) throw new Error("Login cancelled");
      const spki = encode(await crypto.subtle.exportKey("spki", pair.publicKey));
      const publicKey = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;
      const nonce = randomHex();
      if (version !== generation) throw new Error("Login cancelled");
      pending = { site, privateKey: pair.privateKey, nonce, expires: now() + TTL, windowId, clientId, publicKey };
      const url = new URL("/user-api-key/new", site.origin);
      url.search = new URLSearchParams({ application_name: "Discourse Chat Wrapper", client_id: clientId,
        nonce, public_key: publicKey, scopes: "write", padding: "oaep" }).toString();
      const attempt = pending;
      const capability = await send(url.origin + "/user-api-key/new", { method: "HEAD" });
      if (pending !== attempt) throw new Error("Login cancelled");
      if (capability.ok && capability.headers.get("Auth-Api-Device-Code") === "true") {
        const response = await post(attempt, "/user-api-key/device.json", Object.fromEntries(url.searchParams));
        if (!response.ok) throw new Error("Couldn’t start device authorization on this site.");
        const data = await response.json();
        if (pending !== attempt) throw new Error("Login cancelled");
        const verification = new URL(data.verification_uri_with_request || data.verification_uri);
        if (verification.origin !== site.origin || verification.username || verification.password ||
            verification.pathname !== "/user-api-key/activate" ||
            !/^[a-f0-9]{64}$/i.test(data.device_code) || typeof data.user_code !== "string" ||
            !data.user_code.length || data.user_code.length > 32 || !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
            !Number.isFinite(data.interval) || data.interval <= 0 || data.interval > 60) {
          throw new Error("Invalid device authorization response.");
        }
        attempt.mode = "device";
        attempt.deviceCode = data.device_code;
        attempt.interval = Math.max(5, data.interval) * 1000;
        attempt.expires = Math.min(attempt.expires, now() + data.expires_in * 1000);
        attempt.nextPoll = now() + attempt.interval;
        return { url: verification.href, site, mode: "device", code: data.user_code,
          interval: attempt.interval, expiresIn: attempt.expires - now() };
      }
      attempt.mode = "paste";
      return { url: url.href, site, mode: "paste", expiresIn: attempt.expires - now() };
    },
    async paste(value) {
      const attempt = current();
      if (!attempt || attempt.mode !== "paste") throw new Error("Start browser sign-in again.");
      return exchange(value, attempt);
    },
    async poll() {
      const attempt = current();
      if (!attempt || attempt.mode !== "device") return null;
      if (attempt.polling || now() < attempt.nextPoll) return null;
      attempt.polling = true;
      try {
        const response = await post(attempt, "/user-api-key/device/poll.json", { device_code: attempt.deviceCode });
        if (pending !== attempt) return null;
        if (response.status === 429) { attempt.interval = Math.min(60000, attempt.interval * 2); return null; }
        if (!response.ok) throw new Error("Couldn’t check browser approval. Start browser sign-in again.");
        const data = await response.json();
        if (current() !== attempt) return null;
        if (data.status === "authorization_pending") return null;
        if (data.status === "authorized") return await exchange(data.payload, attempt);
        pending = null;
        throw new Error(data.status === "access_denied" ? "Browser sign-in was denied." : "Login expired. Start browser sign-in again.");
      } finally { attempt.polling = false; attempt.nextPoll = now() + attempt.interval; }
    },
  };
}

export function newClientId() { return `discourse-chat-wrapper-${randomHex()}`; }
