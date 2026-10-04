import { assertSite } from "./sites.js";
const APP_ID = "org.discourse.dev.chat.tinyjs.poc";

export function chatDestination(value, site) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value, site?.origin);
    if (url.origin !== site?.origin || !/^\/chat(?:\/|$)/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

// Kept in memory only. Quitting stops notifications; no push registration or
// credentials are stored. Message text is never written to disk or logs.
export function createNotifications(site) {
  const seen = new Map();
  const destinations = new Map();
  let enabled = true;
  let disposed = false;
  let listenerReady = false;
  let tail = Promise.resolve();
  const remember = (map, key, value) => {
    map.set(key, value);
    if (map.size > 500) map.delete(map.keys().next().value);
  };

  async function deliver(payload, app) {
    if (disposed) return { delivered: false, reason: "inactive-site" };
    if (!enabled) return { delivered: false, reason: "disabled" };
    const destination = chatDestination(payload.url, site);
    if (!destination || !Number.isSafeInteger(payload.messageId) || payload.messageId <= 0) {
      return { delivered: false, reason: "invalid" };
    }
    const id = `chat-${encodeURIComponent(site.origin)}-${payload.messageId}`;
    if (seen.has(id)) return { delivered: false, reason: "duplicate" };
    // Also remember alerts received while focused: reconnecting must not
    // replay them after the user switches to another application.
    remember(seen, id, true);
    const [state, frontmost] = await Promise.all([app.getWinState(), app.frontmostApp()]);
    if (disposed) return { delivered: false, reason: "inactive-site" };
    if (state?.focused || frontmost?.bundleId === APP_ID) {
      return { delivered: false, reason: "focused" };
    }
    // Fail closed if the native focus query could not establish app state.
    if (!state || typeof state.focused !== "boolean") return { delivered: false, reason: "unknown-focus" };
    const title = typeof payload.title === "string" ? payload.title.slice(0, 160) : "New chat message";
    const body = typeof payload.body === "string" ? payload.body.slice(0, 500) : "";
    remember(destinations, id, destination);
    const delivered = await app.notify({ id, title, body, subtitle: "Discourse Chat App", sound: true });
    return { delivered: delivered !== false };
  }

  return {
    dispose() { disposed = true; destinations.clear(); seen.clear(); },
    setEnabled(value) { enabled = !!value; },
    get enabled() { return enabled; },
    get ready() { return listenerReady; },
    setReady(value) { listenerReady = !!value; },
    receive(payload, app, caller) {
      assertSite(site, caller);
      // Serialize checks/delivery so rapid duplicate MessageBus events cannot
      // race each other through the native focus query.
      const result = tail.then(() => deliver(payload ?? {}, app));
      tail = result.catch(() => {});
      return result;
    },
    click(id, app) {
      const destination = destinations.get(id);
      if (disposed || !destination) return;
      app.restore();
      app.show();
      app.eval(`location.href = ${JSON.stringify(destination)}`);
    },
  };
}
