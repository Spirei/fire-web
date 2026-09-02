import path from "node:path";
import { getSiteSettings } from "@/lib/settings";
import { readJsonFile, writeJsonAtomic } from "@/lib/tradingSquareCache";
import { backfillTrumpTranslations } from "@/lib/tradingSquareTranslate";
import { proxyFetch } from "@/lib/net";

const DATA = path.join(process.cwd(), "data");
const TRUMP_FILE = path.join(DATA, "trump-posts.json");
const DUAN_FILE = path.join(DATA, "duan-posts.json");
const TRUMP_SOURCE = "https://trumpstruth.org/";
const DUAN_USER = "1247347556";

export type TrumpPost = { id: string; date: string; text: string; originalUrl: string; archiveUrl: string };
type DuanCategory = "hot" | "original" | "longform";
export type Quote = { name: string; text: string; url?: string };
export type DuanPost = { id: string; date: string; text: string; originalUrl: string; categories: DuanCategory[]; replies?: number; likes?: number; quote?: Quote };

type XueqiuStatus = {
  id?: number | string;
  created_at?: number | string;
  text?: string;
  description?: string;
  title?: string;
  like_count?: number;
  reply_count?: number;
  comments_count?: number;
  target?: string;
  user?: { id?: number | string; screen_name?: string; name?: string };
  retweeted_status?: XueqiuStatus;
  retweet_status?: XueqiuStatus;
  reply_comment?: XueqiuStatus;
  reply_status?: XueqiuStatus;
  quoted_status?: XueqiuStatus;
  comment?: XueqiuStatus;
};

let xueqiuCookie = "";

function mergeSetCookie(existing: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name && rest.length) map.set(name, rest.join("="));
  }
  for (const raw of setCookies) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function xueqiuFetch(pathAndQuery: string): Promise<unknown | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Referer: "https://xueqiu.com/u/slowisquick",
    Accept: "application/json"
  };
  if (xueqiuCookie) headers.Cookie = xueqiuCookie;
  const urls = [`https://xueqiu.com${pathAndQuery}`, `https://api.xueqiu.com${pathAndQuery}`];
  for (const url of urls) {
    try {
      const response = await proxyFetch(url, { headers, signal: AbortSignal.timeout(4000), cache: "no-store" });
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (setCookies.length) {
        xueqiuCookie = mergeSetCookie(xueqiuCookie, setCookies);
        headers.Cookie = xueqiuCookie;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("json")) continue;
      const json = await response.json() as { error_code?: unknown };
      if (json && typeof json === "object" && json.error_code) continue;
      return json;
    } catch {
      /* try next host */
    }
  }
  return null;
}

async function warmXueqiuSession() {
  if (xueqiuCookie) return;
  try {
    const response = await proxyFetch("https://xueqiu.com/u/slowisquick", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store"
    });
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (setCookies.length) xueqiuCookie = mergeSetCookie(xueqiuCookie, setCookies);
  } catch {
    /* continue without pre-warmed cookies */
  }
}

let trumpRunning = false;
let duanRunning = false;

function clean(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

export function postTimestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function toIsoDate(value: string): string {
  const time = postTimestamp(value);
  return time ? new Date(time).toISOString() : value;
}

function parseTrumpPage(html: string, source: string): TrumpPost[] {
  return html.split('<div class="status"').slice(1).map((tail, index) => {
    const block = tail.split('<div class="status"')[0];
    const date = toIsoDate(block.match(/status-info__meta-item">([^<]+,\s*\d{4},\s*[^<]+)</)?.[1] ?? "");
    const originalUrl = block.match(/href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/[^" ]+)"/)?.[1] ?? "https://truthsocial.com/@realDonaldTrump";
    const content = clean(block.match(/<div class="status__content">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const archiveUrl = block.match(/data-status-url="([^" ]+)/)?.[1] ?? source;
    return {
      id: archiveUrl.split("/").pop() || String(index),
      date,
      text: content,
      originalUrl,
      archiveUrl: archiveUrl.startsWith("http") ? archiveUrl : `https://trumpstruth.org/statuses/${archiveUrl}`
    };
  }).filter((post) => post.text && post.date);
}

export function readTrumpPosts(): TrumpPost[] {
  return readJsonFile<TrumpPost[]>(TRUMP_FILE, []);
}

export function readDuanPosts(): DuanPost[] {
  return readJsonFile<DuanPost[]>(DUAN_FILE, []);
}

/** 有缓存时只翻到与旧帖重叠为止；不再按天数丢弃历史。 */
export async function refreshTrumpPosts(): Promise<TrumpPost[]> {
  if (trumpRunning) return readTrumpPosts();
  trumpRunning = true;
  const existing = readTrumpPosts();
  const known = new Set(existing.map((post) => post.id));
  const settings = getSiteSettings();
  const source = settings.trumpArchiveApiUrl || TRUMP_SOURCE;
  const incoming: TrumpPost[] = [];
  let nextUrl = source;
  let overlap = 0;
  const maxPages = existing.length < 200 ? 40 : 5;
  try {
    for (let page = 0; page < maxPages && nextUrl; page += 1) {
      const response = await fetch(nextUrl, {
        headers: { "User-Agent": "Fire/1.0 public archive reader" },
        cache: "no-store",
        signal: AbortSignal.timeout(4000)
      });
      if (!response.ok) break;
      const html = await response.text();
      const parsed = parseTrumpPage(html, source);
      if (!parsed.length) break;
      for (const post of parsed) {
        if (known.has(post.id)) {
          overlap += 1;
          continue;
        }
        known.add(post.id);
        incoming.push(post);
      }
      const next = html.match(/<a href="([^"]*cursor=[^"]+)"[^>]*>Next Page/i)?.[1];
      nextUrl = next ? new URL(next.replace(/&amp;/g, "&"), source).toString() : "";
      if (existing.length >= 200 && overlap >= 2) nextUrl = "";
    }
    const merged = Array.from(new Map([...incoming, ...existing].map((post) => [post.id, { ...post, date: toIsoDate(post.date) }])).values());
    try { writeJsonAtomic(TRUMP_FILE, merged); } catch { /* read-only deployments */ }
    void backfillTrumpTranslations(merged, 3);
    return merged;
  } finally {
    trumpRunning = false;
  }
}

function duanCategories(text: string, likes = 0, replies = 0): DuanCategory[] {
  const values: DuanCategory[] = [];
  if (likes >= 500 || replies >= 100) values.push("hot");
  if (!/^\s*(回复|转发|\/\/|@)/.test(text)) values.push("original");
  if (text.length >= 240) values.push("longform");
  return values;
}

function asQuote(value: unknown): Quote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as XueqiuStatus;
  const user = item.user && typeof item.user === "object" ? item.user : {};
  const name = String(user.screen_name || user.name || "").trim();
  const text = clean(String(item.text || item.description || item.title || ""));
  if (!text) return undefined;
  const id = item.id != null ? String(item.id) : "";
  const uid = user.id != null ? String(user.id) : "";
  return { name: name || "原动态", text, url: id && uid ? `https://xueqiu.com/${uid}/${id}` : undefined };
}

function extractQuote(item: XueqiuStatus): Quote | undefined {
  return asQuote(item.reply_comment) || asQuote(item.reply_status) || asQuote(item.comment) || asQuote(item.retweeted_status) || asQuote(item.retweet_status) || asQuote(item.quoted_status);
}

function mapDuanStatus(item: XueqiuStatus): DuanPost | null {
  const text = clean(item.text || item.description || item.title || "");
  const id = String(item.id || "");
  if (!id || !text) return null;
  const likes = Number(item.like_count || 0);
  const replies = Number(item.reply_count || item.comments_count || 0);
  const quote = extractQuote(item);
  return {
    id,
    date: typeof item.created_at === "number" ? new Date(item.created_at).toISOString() : new Date(item.created_at || Date.now()).toISOString(),
    text,
    originalUrl: `https://xueqiu.com/${DUAN_USER}/${item.id}`,
    categories: duanCategories(text, likes, replies),
    likes,
    replies,
    ...(quote && quote.text !== text ? { quote } : {})
  };
}

async function fillMissingQuotes(posts: DuanPost[]): Promise<DuanPost[]> {
  const missing = posts.filter((post) => !post.quote && /^\s*回复@/.test(post.text)).slice(0, 40);
  if (!missing.length) return posts;
  const quotes = new Map<string, Quote>();
  for (let index = 0; index < missing.length; index += 3) {
    const batch = missing.slice(index, index + 3);
    await Promise.all(batch.map(async (post) => {
      const detail = await xueqiuFetch(`/statuses/show.json?id=${encodeURIComponent(post.id)}`) as XueqiuStatus | null;
      const quote = detail ? extractQuote(detail) : undefined;
      if (quote && quote.text !== post.text) quotes.set(post.id, quote);
    }));
  }
  if (!quotes.size) return posts;
  return posts.map((post) => quotes.has(post.id) ? { ...post, quote: quotes.get(post.id) } : post);
}

export async function refreshDuanPosts(): Promise<DuanPost[]> {
  if (duanRunning) return readDuanPosts();
  duanRunning = true;
  const existing = readDuanPosts();
  const known = new Set(existing.map((post) => post.id));
  const needsQuoteBackfill = existing.some((post) => !post.quote && /^\s*回复@/.test(post.text));
  const live: DuanPost[] = [];
  const maxPages = existing.length < 200 || needsQuoteBackfill ? 40 : 5;
  try {
    await warmXueqiuSession();
    for (let page = 1; page <= maxPages; page += 1) {
      const data = await xueqiuFetch(`/v4/statuses/user_timeline.json?user_id=${DUAN_USER}&page=${page}&count=20&type=0`) as { statuses?: XueqiuStatus[] } | null;
      if (!data) break;
      const batch = (data.statuses || []).map(mapDuanStatus).filter((item): item is DuanPost => item !== null);
      if (!batch.length) break;
      let overlap = 0;
      for (const item of batch) {
        if (known.has(item.id)) overlap += 1;
        else known.add(item.id);
        live.push(item);
      }
      if (existing.length >= 200 && !needsQuoteBackfill && overlap >= 3) break;
    }
    const quoted = await fillMissingQuotes(live);
    if (!quoted.length) return existing;
    const merged = new Map(existing.map((item) => [item.id, item]));
    quoted.forEach((item) => {
      const saved = merged.get(item.id);
      merged.set(item.id, {
        ...saved,
        ...item,
        quote: item.quote || saved?.quote,
        categories: Array.from(new Set([...(saved?.categories || []), ...item.categories]))
      });
    });
    const posts = Array.from(merged.values()).sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
    try { writeJsonAtomic(DUAN_FILE, posts); } catch { /* read-only deployment */ }
    return posts;
  } catch {
    return existing;
  } finally {
    duanRunning = false;
  }
}

export function isTrumpRefreshing() {
  return trumpRunning;
}

export function isDuanRefreshing() {
  return duanRunning;
}
