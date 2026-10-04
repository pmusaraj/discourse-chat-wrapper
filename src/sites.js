export function normalizeSite(value) {
  const input = String(value ?? "").trim();
  if (!input || input.length > 2048) throw new Error("Enter your Discourse site address.");
  let url;
  try { url = new URL(input.includes("://") ? input : `https://${input}`); }
  catch { throw new Error("Enter a valid site address, such as community.example.com."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use an HTTPS site address without a username or password.");
  if (url.pathname !== "/" && !/^\/chat(?:\/|$)/.test(url.pathname)) {
    throw new Error("Enter the site’s main address. Sites installed in a subfolder aren’t supported yet.");
  }
  return { origin: url.origin, chatURL: `${url.origin}/chat/`, name: url.host };
}

export function assertLocal(caller) {
  if (caller?.window !== "main" || caller?.origin !== "file://") throw new Error("Only the site picker can change the site.");
}

export function assertSite(site, caller) {
  if (!site || caller?.window !== "main" || caller?.origin !== site.origin) throw new Error("Untrusted site or window");
}

export async function loadSite(store) {
  const saved = await store.get("activeSite");
  if (!saved) return null;
  try { return normalizeSite(saved); } catch { return null; }
}
