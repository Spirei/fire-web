import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "@/lib/tradingSquareCache";
import { getSiteSettings } from "@/lib/settings";
import { backfillTrumpTranslations } from "@/lib/tradingSquareTranslate";
import { isDuanRefreshing, isTrumpRefreshing, postTimestamp, readTrumpPosts, refreshDuanPosts, refreshTrumpPosts } from "@/lib/tradingSquareRefresh";

type CachedPost = { id: string; date: string; text: string; textZh?: string; originalUrl: string; categories?: string[]; quote?: { name: string; text: string; url?: string } };
type FeedPost = CachedPost & { author: "trump" | "duan" };
const DATA = path.join(process.cwd(), "data");
const TRUMP = path.join(DATA, "trump-posts.json");
const TRANSLATIONS = path.join(DATA, "trump-translations.json");
const DUAN = path.join(DATA, "duan-posts.json");
const lastRefreshAttempt = { trump: 0, duan: 0 };
let assembled: { key: string; posts: FeedPost[]; updatedAt: number; updatedByAuthor: { trump: number; duan: number } } | null = null;
let scheduled = false;

function modifiedAt(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function assembleFeed() {
  const trumpAt = modifiedAt(TRUMP);
  const duanAt = modifiedAt(DUAN);
  const key = `${trumpAt}:${modifiedAt(TRANSLATIONS)}:${duanAt}`;
  if (assembled?.key === key) return assembled;
  const translations = readJsonFile<Record<string, string>>(TRANSLATIONS, {});
  const trump = readJsonFile<CachedPost[]>(TRUMP, []).map((post) => translations[post.id] ? { ...post, textZh: translations[post.id], author: "trump" as const } : { ...post, author: "trump" as const });
  const duan = readJsonFile<CachedPost[]>(DUAN, []).map((post) => ({ ...post, author: "duan" as const }));
  const posts = [...trump, ...duan].sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
  assembled = {
    key,
    posts,
    updatedAt: Math.max(trumpAt, modifiedAt(TRANSLATIONS), duanAt),
    updatedByAuthor: { trump: trumpAt, duan: duanAt }
  };
  return assembled;
}

function dueRefresh() {
  const settings = getSiteSettings();
  const now = Date.now();
  return {
    trump: now - Math.max(modifiedAt(TRUMP), lastRefreshAttempt.trump) >= settings.tradingSquareTrumpRefreshMinutes * 60_000,
    duan: now - Math.max(modifiedAt(DUAN), lastRefreshAttempt.duan) >= settings.tradingSquareDuanRefreshMinutes * 60_000
  };
}

async function runBackgroundRefresh() {
  const due = dueRefresh();
  const now = Date.now();
  if (due.trump) lastRefreshAttempt.trump = now;
  if (due.duan) lastRefreshAttempt.duan = now;
  try {
    if (due.trump) await refreshTrumpPosts();
    if (due.duan) await refreshDuanPosts();
    void backfillTrumpTranslations(readTrumpPosts(), 20);
  } catch {
    /* keep serving local cache */
  }
}

function scheduleBackgroundRefresh() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    void runBackgroundRefresh().finally(() => { scheduled = false; });
  }, 0);
}

export async function GET() {
  const settings = getSiteSettings();
  const feed = assembleFeed();
  const due = dueRefresh();
  const refreshingByAuthor = {
    trump: due.trump || isTrumpRefreshing(),
    duan: due.duan || isDuanRefreshing()
  };
  scheduleBackgroundRefresh();
  return NextResponse.json({
    posts: feed.posts,
    updatedAt: feed.updatedAt ? new Date(feed.updatedAt).toISOString() : null,
    updatedByAuthor: {
      trump: feed.updatedByAuthor.trump ? new Date(feed.updatedByAuthor.trump).toISOString() : null,
      duan: feed.updatedByAuthor.duan ? new Date(feed.updatedByAuthor.duan).toISOString() : null
    },
    source: "local-cache",
    refreshing: refreshingByAuthor.trump || refreshingByAuthor.duan,
    refreshingByAuthor,
    refreshMinutes: { trump: settings.tradingSquareTrumpRefreshMinutes, duan: settings.tradingSquareDuanRefreshMinutes }
  }, { headers: { "Cache-Control": "no-store" } });
}
