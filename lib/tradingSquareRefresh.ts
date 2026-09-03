import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sniffImageExt } from "@/lib/imageSecurity";
import { isAllowedRemoteImageUrl, isLocalPostImageUrl } from "@/lib/tradingSquareImages";
import { getSiteSettings } from "@/lib/settings";
import { readJsonFile, writeJsonAtomic } from "@/lib/tradingSquareCache";
import { backfillTrumpTranslations, translateTrumpPostsNow } from "@/lib/tradingSquareTranslate";
import { proxyFetch } from "@/lib/net";

const DATA = path.join(process.cwd(), "data");
const TRUMP_FILE = path.join(DATA, "trump-posts.json");
const DUAN_FILE = path.join(DATA, "duan-posts.json");
const TRUMP_SOURCE = "https://trumpstruth.org/";
const DUAN_USER = "1247347556";

export type TrumpPost = { id: string; date: string; text: string; originalUrl: string; archiveUrl: string; images?: string[] };
type DuanCategory = "hot" | "original" | "longform";
export type Quote = { name: string; text: string; url?: string; images?: string[] };
export type DuanPost = { id: string; date: string; text: string; originalUrl: string; categories: DuanCategory[]; replies?: number; likes?: number; quote?: Quote; images?: string[] };

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
  pic?: unknown;
  pics?: unknown;
  pic_urls?: unknown;
  original_pic?: unknown;
  bmiddle_pic?: unknown;
  thumbnail_pic?: unknown;
  cover_pic?: unknown;
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

function absoluteUrl(value: string): string {
  const url = value.trim();
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function isPostImage(url: string): boolean {
  if (!isAllowedRemoteImageUrl(url)) return false;
  if (/avatar|logo\.svg|emoji|profile_image|accounts\/avatars|preview_cards|status-info__avatar/i.test(url)) return false;
  return /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) || /xqimg|imedao|linodeobjects|\/attachments\/|media_attachments/i.test(url);
}

function collectUrls(value: unknown, into: string[]) {
  if (!value) return;
  if (typeof value === "string") {
    if (value.includes(",") && /https?:/i.test(value)) {
      value.split(",").forEach((part) => collectUrls(part.trim(), into));
      return;
    }
    const url = absoluteUrl(value);
    if (isPostImage(url)) into.push(url);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, into));
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    collectUrls(record.url ?? record.src ?? record.pic ?? record.original ?? record.large ?? record.original_pic, into);
  }
}

function uniqueImages(urls: string[]): string[] | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  urls.forEach((url) => {
    const cleanUrl = url.replace(/!.*$/, "");
    if (seen.has(cleanUrl) || seen.has(url)) return;
    seen.add(cleanUrl);
    seen.add(url);
    list.push(url);
  });
  return list.length ? list.slice(0, 9) : undefined;
}

function imagesFromHtml(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((match) => absoluteUrl(match[1]));
}

function extractXueqiuImages(item: XueqiuStatus): string[] | undefined {
  const urls: string[] = [];
  collectUrls(item.pic, urls);
  collectUrls(item.pics, urls);
  collectUrls(item.pic_urls, urls);
  collectUrls(item.original_pic, urls);
  collectUrls(item.bmiddle_pic, urls);
  collectUrls(item.thumbnail_pic, urls);
  collectUrls(item.cover_pic, urls);
  imagesFromHtml(String(item.text || item.description || "")).forEach((url) => collectUrls(url, urls));
  return uniqueImages(urls);
}

function extractTrumpImages(block: string): string[] | undefined {
  const hrefs = [...block.matchAll(/status-attachment__link[^>]*href=["']([^"']+)["']/gi)].map((match) => absoluteUrl(match[1]));
  return uniqueImages([...imagesFromHtml(block), ...hrefs].filter((url) => isPostImage(url)));
}

const IMAGE_DIR = path.join(process.cwd(), "public", "uploads", "trading-square");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const localIndex = new Map<string, Map<string, string>>();

function sourceKey(url: string): string {
  return createHash("sha1").update(url.replace(/!.*$/, "")).digest("hex").slice(0, 16);
}

function lookupLocal(author: string, key: string): string | undefined {
  let folder = localIndex.get(author);
  if (!folder) {
    folder = new Map();
    try {
      for (const name of fs.readdirSync(path.join(IMAGE_DIR, author))) {
        const local = `/uploads/trading-square/${author}/${name}`;
        if (isLocalPostImageUrl(local)) folder.set(name.replace(/\.[^.]+$/, ""), local);
      }
    } catch {
      /* first download creates the folder */
    }
    localIndex.set(author, folder);
  }
  return folder.get(key);
}

function rememberLocal(author: string, key: string, url: string) {
  let folder = localIndex.get(author);
  if (!folder) {
    folder = new Map();
    localIndex.set(author, folder);
  }
  folder.set(key, url);
}

async function downloadImage(author: string, url: string): Promise<string | undefined> {
  if (author !== "trump" && author !== "duan") return undefined;
  if (isLocalPostImageUrl(url)) return url;
  if (!isAllowedRemoteImageUrl(url)) return undefined;
  const key = sourceKey(url);
  const existing = lookupLocal(author, key);
  if (existing && isLocalPostImageUrl(existing)) return existing;
  try {
    const referer = /xueqiu|imedao|xqimg/i.test(url) ? "https://xueqiu.com/" : "https://trumpstruth.org/";
    const response = await proxyFetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Referer: referer,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "follow"
    });
    if (!response.ok) return undefined;
    if (!isAllowedRemoteImageUrl(response.url || url)) return undefined;
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return undefined;
    const ext = sniffImageExt(buf);
    if (!ext || ext === "svg" || ext === "ico") return undefined;
    const dir = path.join(IMAGE_DIR, author);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${key}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    const local = `/uploads/trading-square/${author}/${filename}`;
    if (!isLocalPostImageUrl(local)) return undefined;
    rememberLocal(author, key, local);
    return local;
  } catch {
    return undefined;
  }
}

function remoteImageUrls(urls?: string[]): string[] {
  return (urls || []).filter((url) => /^https?:\/\//i.test(url) && isPostImage(url));
}

async function localizeUrlMap(author: string, urls: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(remoteImageUrls(urls))];
  for (let index = 0; index < unique.length; index += 4) {
    const batch = unique.slice(index, index + 4);
    await Promise.all(batch.map(async (url) => {
      const local = await downloadImage(author, url);
      if (local) map.set(url, local);
    }));
  }
  return map;
}

export function keepLocalImages(urls?: string[], map?: Map<string, string>): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  (urls || []).forEach((url) => {
    const local = isLocalPostImageUrl(url) ? url : map?.get(url);
    if (!local || !isLocalPostImageUrl(local) || seen.has(local)) return;
    seen.add(local);
    out.push(local);
  });
  return out.length ? out : undefined;
}

export function withoutRemoteImages<T extends { images?: string[]; quote?: { images?: string[] } }>(post: T, map?: Map<string, string>): T {
  const next = { ...post };
  const images = keepLocalImages(post.images, map);
  if (images) next.images = images;
  else delete next.images;
  if (next.quote) {
    const quote = { ...next.quote };
    const quoteImages = keepLocalImages(quote.images, map);
    if (quoteImages) quote.images = quoteImages;
    else delete quote.images;
    next.quote = quote;
  }
  return next;
}

function parseTrumpPage(html: string, source: string): TrumpPost[] {
  return html.split('<div class="status"').slice(1).map((tail, index) => {
    const block = tail.split('<div class="status"')[0];
    const date = toIsoDate(block.match(/status-info__meta-item">([^<]+,\s*\d{4},\s*[^<]+)</)?.[1] ?? "");
    const originalUrl = block.match(/href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/[^" ]+)"/)?.[1] ?? "https://truthsocial.com/@realDonaldTrump";
    const content = clean(block.match(/<div class="status__content">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const rawArchive = block.match(/data-status-url="([^" ]+)/)?.[1] ?? source;
    const archiveUrl = rawArchive.startsWith("http") ? rawArchive : `https://trumpstruth.org/statuses/${rawArchive}`;
    const archiveId = archiveUrl.split("/").pop() || "";
    const truthId = originalUrl.match(/\/(\d{8,})$/)?.[1] || "";
    const id = /^\d{4,}$/.test(archiveId) ? archiveId : truthId || String(index);
    const images = extractTrumpImages(block);
    return {
      id,
      date,
      text: content,
      originalUrl,
      archiveUrl,
      ...(images ? { images } : {})
    };
  }).filter((post) => post.date && (post.text || post.images?.length));
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
        if (known.has(post.id)) overlap += 1;
        else known.add(post.id);
        incoming.push(post);
      }
      const next = html.match(/<a href="([^"]*cursor=[^"]+)"[^>]*>Next Page/i)?.[1];
      nextUrl = next ? new URL(next.replace(/&amp;/g, "&"), source).toString() : "";
      if (existing.length >= 200 && overlap >= 2) nextUrl = "";
    }
    if (incoming.length) {
      const newest = [...incoming].sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
      await translateTrumpPostsNow(newest.slice(0, 15));
    }
    const localMap = await localizeUrlMap("trump", [
      ...incoming.flatMap((post) => post.images || []),
      ...existing.flatMap((post) => post.images || [])
    ]);
    const merged = new Map(existing.map((post) => [post.id, post]));
    incoming.forEach((post) => {
      const saved = merged.get(post.id);
      const images = keepLocalImages(post.images?.length ? post.images : saved?.images, localMap);
      const next = {
        ...saved,
        ...post,
        date: toIsoDate(post.date)
      };
      if (images) next.images = images;
      else delete next.images;
      merged.set(post.id, next);
    });
    const mergedPosts = Array.from(merged.values()).map((post) => withoutRemoteImages(post, localMap));
    try { writeJsonAtomic(TRUMP_FILE, mergedPosts); } catch { /* read-only deployments */ }
    void backfillTrumpTranslations(mergedPosts, 20);
    return mergedPosts;
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
  const images = extractXueqiuImages(item);
  return { name: name || "原动态", text, url: id && uid ? `https://xueqiu.com/${uid}/${id}` : undefined, ...(images ? { images } : {}) };
}

function extractQuote(item: XueqiuStatus): Quote | undefined {
  return asQuote(item.reply_comment) || asQuote(item.reply_status) || asQuote(item.comment) || asQuote(item.retweeted_status) || asQuote(item.retweet_status) || asQuote(item.quoted_status);
}

function mapDuanStatus(item: XueqiuStatus): DuanPost | null {
  const images = extractXueqiuImages(item);
  const text = clean(item.text || item.description || item.title || "");
  const id = String(item.id || "");
  if (!id || (!text && !images?.length)) return null;
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
    ...(images ? { images } : {}),
    ...(quote && quote.text !== text ? { quote } : {})
  };
}

async function fillMissingQuotes(posts: DuanPost[]): Promise<DuanPost[]> {
  const missing = posts.filter((post) => !post.quote && /^\s*回复@/.test(post.text)).slice(0, 40);
  if (!missing.length) return posts;
  const quotes = new Map<string, Quote>();
  const images = new Map<string, string[]>();
  for (let index = 0; index < missing.length; index += 3) {
    const batch = missing.slice(index, index + 3);
    await Promise.all(batch.map(async (post) => {
      const detail = await xueqiuFetch(`/statuses/show.json?id=${encodeURIComponent(post.id)}`) as XueqiuStatus | null;
      if (!detail) return;
      const quote = extractQuote(detail);
      if (quote && quote.text !== post.text) quotes.set(post.id, quote);
      const pics = extractXueqiuImages(detail);
      if (pics?.length && !post.images?.length) images.set(post.id, pics);
    }));
  }
  if (!quotes.size && !images.size) return posts;
  return posts.map((post) => ({
    ...post,
    ...(quotes.has(post.id) ? { quote: quotes.get(post.id) } : {}),
    ...(images.has(post.id) ? { images: images.get(post.id) } : {})
  }));
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
    const remoteUrls = [
      ...quoted.flatMap((item) => [...(item.images || []), ...(item.quote?.images || [])]),
      ...existing.flatMap((item) => [...(item.images || []), ...(item.quote?.images || [])])
    ];
    const localMap = await localizeUrlMap("duan", remoteUrls);
    const merged = new Map(existing.map((item) => [item.id, item]));
    quoted.forEach((item) => {
      const saved = merged.get(item.id);
      const images = keepLocalImages(item.images?.length ? item.images : saved?.images, localMap);
      const quoteSource = item.quote || saved?.quote;
      const quoteImages = quoteSource ? keepLocalImages(quoteSource.images?.length ? quoteSource.images : saved?.quote?.images, localMap) : undefined;
      const next = {
        ...saved,
        ...item,
        quote: quoteSource ? { ...quoteSource, ...(quoteImages ? { images: quoteImages } : {}) } : undefined,
        categories: Array.from(new Set([...(saved?.categories || []), ...item.categories]))
      };
      if (images) next.images = images;
      else delete next.images;
      if (next.quote && !quoteImages) delete next.quote.images;
      merged.set(item.id, next);
    });
    const posts = Array.from(merged.values()).map((item) => withoutRemoteImages(item, localMap)).sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
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
