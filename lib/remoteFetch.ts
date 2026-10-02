import { proxyFetch } from "./net";

/** GET-only remote content: check each Location before making the next network request. */
export async function fetchAllowedRemoteGet(raw: string, allowed: (url: string) => boolean, init: Omit<RequestInit, "body" | "method" | "redirect"> = {}): Promise<Response> {
  let url = new URL(raw).href;
  for (let hop = 0; hop <= 3; hop++) {
    if (!allowed(url)) throw new Error("remote_url_not_allowed");
    const response = await proxyFetch(url, { ...init, method: "GET", redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || hop === 3) throw new Error("remote_redirect_limit");
    url = new URL(location, url).href;
  }
  throw new Error("remote_redirect_limit");
}

/** Sources stay on their authorized origin; the built-in publisher has one fixed canonical alias. */
export function sameOriginRemoteUrl(raw: string, source: string): boolean {
  try {
    const url = new URL(raw), base = new URL(source);
    const archiveOrigins = new Set(["https://trumpstruth.org", "https://www.trumpstruth.org"]);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && (url.origin === base.origin || (archiveOrigins.has(base.origin) && archiveOrigins.has(url.origin)));
  } catch {
    return false;
  }
}
