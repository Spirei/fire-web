import path from "node:path";
import { getSiteSettings } from "@/lib/settings";
import { readJsonFile, writeJsonAtomic } from "@/lib/tradingSquareCache";
import { backfillTrumpTranslations } from "@/lib/tradingSquareTranslate";

const DATA = path.join(process.cwd(), "data");
const TRUMP_FILE = path.join(DATA, "trump-posts.json");
const DUAN_FILE = path.join(DATA, "duan-posts.json");
const TRUMP_SOURCE = "https://trumpstruth.org/";
const DUAN_USER = "1247347556";
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type TrumpPost = { id: string; date: string; text: string; originalUrl: string; archiveUrl: string };
type DuanCategory = "hot" | "original" | "longform";
export type DuanPost = { id: string; date: string; text: string; originalUrl: string; categories: DuanCategory[]; replies?: number; likes?: number };

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

/** 有缓存时只翻到与旧帖重叠为止，避免每次刷新抓 30 页归档。 */
export async function refreshTrumpPosts(): Promise<TrumpPost[]> {
  if (trumpRunning) return readTrumpPosts();
  trumpRunning = true;
  const existing = readTrumpPosts();
  const known = new Set(existing.map((post) => post.id));
  const cutoff = Date.now() - WINDOW_MS;
  const settings = getSiteSettings();
  const source = settings.trumpArchiveApiUrl || TRUMP_SOURCE;
  const incoming: TrumpPost[] = [];
  let nextUrl = source;
  let overlap = 0;
  const maxPages = existing.length ? 3 : 12;
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
      let reachedCutoff = false;
      for (const post of parsed) {
        const time = postTimestamp(post.date);
        if (time && time < cutoff) {
          reachedCutoff = true;
          continue;
        }
        if (known.has(post.id)) {
          overlap += 1;
          continue;
        }
        known.add(post.id);
        incoming.push(post);
      }
      const next = html.match(/<a href="([^"]*cursor=[^"]+)"[^>]*>Next Page/i)?.[1];
      nextUrl = next ? new URL(next.replace(/&amp;/g, "&"), source).toString() : "";
      if (reachedCutoff || (existing.length > 0 && overlap >= 2)) nextUrl = "";
    }
    const merged = Array.from(new Map([...incoming, ...existing].filter((post) => {
      const time = postTimestamp(post.date);
      return !time || time >= cutoff;
    }).map((post) => [post.id, { ...post, date: toIsoDate(post.date) }])).values());
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

export async function refreshDuanPosts(): Promise<DuanPost[]> {
  if (duanRunning) return readDuanPosts();
  duanRunning = true;
  const existing = readDuanPosts();
  const known = new Set(existing.map((post) => post.id));
  const cutoff = Date.now() - WINDOW_MS;
  const live: DuanPost[] = [];
  const maxPages = existing.length ? 2 : 8;
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await fetch(
        `https://xueqiu.com/v4/statuses/user_timeline.json?user_id=${DUAN_USER}&page=${page}&count=20&type=0`,
        {
          headers: { "User-Agent": "Mozilla/5.0", Referer: "https://xueqiu.com/u/slowisquick", Accept: "application/json" },
          signal: AbortSignal.timeout(3000),
          cache: "no-store"
        }
      );
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("json")) break;
      const data = await response.json() as {
        statuses?: Array<{ id?: number | string; created_at?: number | string; text?: string; description?: string; title?: string; like_count?: number; reply_count?: number; comments_count?: number }>;
      };
      const batch = (data.statuses || []).map((item) => {
        const text = clean(item.text || item.description || item.title || "");
        const likes = Number(item.like_count || 0);
        const replies = Number(item.reply_count || item.comments_count || 0);
        return {
          id: String(item.id || ""),
          date: typeof item.created_at === "number" ? new Date(item.created_at).toISOString() : new Date(item.created_at || Date.now()).toISOString(),
          text,
          originalUrl: `https://xueqiu.com/${DUAN_USER}/${item.id}`,
          categories: duanCategories(text, likes, replies),
          likes,
          replies
        };
      }).filter((item) => item.id && item.text);
      let overlap = 0;
      for (const item of batch) {
        if (postTimestamp(item.date) < cutoff) continue;
        if (known.has(item.id)) overlap += 1;
        live.push(item);
      }
      if (!batch.length || batch.some((item) => postTimestamp(item.date) < cutoff) || (existing.length > 0 && overlap >= 3)) break;
    }
    if (!live.length) return existing;
    const merged = new Map(existing.filter((item) => postTimestamp(item.date) >= cutoff).map((item) => [item.id, item]));
    live.forEach((item) => {
      const saved = merged.get(item.id);
      merged.set(item.id, { ...saved, ...item, categories: Array.from(new Set([...(saved?.categories || []), ...item.categories])) });
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
