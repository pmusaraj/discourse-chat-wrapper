import { assertSite } from "./sites.js";

export function isChat(url, site) {
  return url.origin === site?.origin && /^\/chat(?:\/|$)/.test(url.pathname);
}

export function isAuthentication(url, site) {
  return url.origin === site?.origin && /^\/(?:login|login-required|password-reset|logout|session|auth|signup|user-api-key|u\/password-reset|u\/activate-account|u\/account-created)(?:\/|$)/.test(url.pathname);
}

export function createNavigation(site) {
  return {
    policy(value) {
      if (value === "about:blank") return;
      let url;
      try { url = new URL(value); } catch { return "deny"; }
      if (!["http:", "https:"].includes(url.protocol)) return "deny";
      if (isAuthentication(url, site)) return "deny";
      if (isChat(url, site)) return;
      return "external";
    },
  };
}

export function openBrowser({ url }, app, caller, site) {
  assertSite(site, caller);
  const target = new URL(url);
  if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("Unsupported browser URL");
  }
  return app.shell.open(target.href);
}
