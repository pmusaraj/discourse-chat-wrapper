// Runs in the selected site's own webview, so HttpOnly session cookies and
// Discourse CSRF protection work without exposing credentials to the backend.
export function logoutScript(origin) {
  return `(${performLogout.toString()})(${JSON.stringify(origin)})`;
}

async function performLogout(origin) {
  try {
    if (location.origin !== origin) throw new Error("Return to your site before logging out.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const options = { credentials: "same-origin", signal: controller.signal,
        headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } };
      const csrfResponse = await fetch("/session/csrf.json", options);
      if (!csrfResponse.ok) throw new Error("Couldn’t contact the site to log out.");
      const { csrf } = await csrfResponse.json();
      if (!csrf) throw new Error("The site didn’t provide a logout token.");
      const response = await fetch("/session/current.json", { ...options, method: "DELETE",
        headers: { ...options.headers, "X-CSRF-Token": csrf } });
      if (!response.ok) throw new Error("The site couldn’t complete logout.");
      // Confirm this is a Discourse JSON response, not a proxy's HTML error.
      const result = await response.json();
      if (typeof result.redirect_url !== "string") throw new Error("Unexpected logout response.");
    } finally { clearTimeout(timeout); }
    await tiny.api.call("logoutResult", { success: true });
  } catch (error) {
    await tiny.api.call("logoutResult", { success: false }).catch(() => {});

  }
}
