import { after, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "@/lib/tradingSquareCache";

type CachedPost = { id: string; date: string; text: string; textZh?: string; originalUrl: string; categories?: string[] };
const DATA = path.join(process.cwd(), "data");
const TRUMP = path.join(DATA, "trump-posts.json");
const TRANSLATIONS = path.join(DATA, "trump-translations.json");
const DUAN = path.join(DATA, "duan-posts.json");
const REFRESH_INTERVAL = 5 * 60_000;
let refreshRunning = false;
let lastRefreshAttempt = 0;

function modifiedAt(file: string): number { try { return fs.statSync(file).mtimeMs } catch { return 0 } }

async function refreshInBackground(origin: string) {
  if (refreshRunning || Date.now() - lastRefreshAttempt < REFRESH_INTERVAL) return;
  refreshRunning = true;
  lastRefreshAttempt = Date.now();
  try {
    await Promise.allSettled([
      fetch(`${origin}/api/trading-square/duan?refresh=1`, { cache: "no-store", signal: AbortSignal.timeout(60_000) }),
      fetch(`${origin}/api/trading-square/trump?refresh=1`, { cache: "no-store", signal: AbortSignal.timeout(60_000) }),
    ]);
  } finally { refreshRunning = false }
}

export async function GET() {
  const translations = readJsonFile<Record<string, string>>(TRANSLATIONS, {});
  const trump = readJsonFile<CachedPost[]>(TRUMP, []).map(post => translations[post.id] ? { ...post, textZh: translations[post.id], author: "trump" as const } : { ...post, author: "trump" as const });
  const duan = readJsonFile<CachedPost[]>(DUAN, []).map(post => ({ ...post, author: "duan" as const }));
  const posts = [...trump, ...duan].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const updatedAt = Math.max(modifiedAt(TRUMP), modifiedAt(TRANSLATIONS), modifiedAt(DUAN));
  after(() => refreshInBackground(`http://127.0.0.1:${process.env.PORT || "3000"}`));
  return NextResponse.json({ posts, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, source: "local-cache" }, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=60" } });
}
