import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const USER_ID = "1247347556";
const CACHE_FILE = path.join(process.cwd(), "data", "duan-posts.json");
type Category = "hot" | "original" | "longform";
type DuanPost = { id: string; date: string; text: string; originalUrl: string; categories: Category[]; replies?: number; likes?: number };

function clean(value = "") { return value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim(); }
function cached(): DuanPost[] { try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return []; } }
function categories(text: string, likes = 0, replies = 0): Category[] {
  const values: Category[] = [];
  if (likes >= 500 || replies >= 100) values.push("hot");
  if (!/^\s*(回复|转发|\/\/|@)/.test(text)) values.push("original");
  if (text.length >= 240) values.push("longform");
  return values;
}

export async function GET(request: NextRequest) {
  let posts = cached();
  let refreshed = false;
  if (request.nextUrl.searchParams.get("refresh") !== "1") {
    return NextResponse.json({ posts, user: { id: USER_ID, handle: "slowisquick", name: "大道无形我有型" }, source: "cache" });
  }
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const live: DuanPost[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const response = await fetch(`https://xueqiu.com/v4/statuses/user_timeline.json?user_id=${USER_ID}&page=${page}&count=20&type=0`, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://xueqiu.com/u/slowisquick", Accept: "application/json" }, signal: AbortSignal.timeout(3500), cache: "no-store" });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("json")) break;
      const data = await response.json() as { statuses?: Array<{ id?: number | string; created_at?: number | string; text?: string; description?: string; title?: string; like_count?: number; reply_count?: number; comments_count?: number }> };
      const batch = (data.statuses || []).map(item => { const text = clean(item.text || item.description || item.title || ""), likes = Number(item.like_count || 0), replies = Number(item.reply_count || item.comments_count || 0); return { id: String(item.id || ""), date: typeof item.created_at === "number" ? new Date(item.created_at).toISOString() : new Date(item.created_at || Date.now()).toISOString(), text, originalUrl: `https://xueqiu.com/${USER_ID}/${item.id}`, categories: categories(text, likes, replies), likes, replies } }).filter(item => item.id && item.text);
      live.push(...batch.filter(item => Date.parse(item.date) >= cutoff));
      if (!batch.length || batch.some(item => Date.parse(item.date) < cutoff)) break;
    }
    if (live.length) {
      const merged = new Map(posts.filter(item => Date.parse(item.date) >= cutoff).map(item => [item.id, item]));
      live.forEach(item => { const saved = merged.get(item.id); merged.set(item.id, { ...saved, ...item, categories: Array.from(new Set([...(saved?.categories || []), ...item.categories])) }) });
      posts = Array.from(merged.values()).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      refreshed = true;
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(posts, null, 2)); } catch { /* read-only deployment */ }
    }
  } catch { /* serve last known public posts */ }
  return NextResponse.json({ posts, user: { id: USER_ID, handle: "slowisquick", name: "大道无形我有型" }, source: refreshed ? "live" : "cache" });
}
