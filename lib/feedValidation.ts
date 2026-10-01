import { isPrivateHost } from "./net";

export class FeedError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || isPrivateHost(u.hostname) || !u.hostname.includes(".") || /^(?:\[|0\.|224\.|255\.)/.test(u.hostname)) return null;
    u.hash=""; ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"].forEach(k=>u.searchParams.delete(k));
    return u.toString();
  } catch { return null; }
}
