import { after, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "@/lib/tradingSquareCache";
import { getSiteSettings } from "@/lib/settings";

type CachedPost = { id: string; date: string; text: string; textZh?: string; originalUrl: string; categories?: string[] };
const DATA = path.join(process.cwd(), "data");
const TRUMP = path.join(DATA, "trump-posts.json");
const TRANSLATIONS = path.join(DATA, "trump-translations.json");
const DUAN = path.join(DATA, "duan-posts.json");
let refreshRunning = false;
const lastRefreshAttempt = { trump: 0, duan: 0 };

function modifiedAt(file: string): number { try { return fs.statSync(file).mtimeMs } catch { return 0 } }

async function refreshInBackground(origin: string) {
  if (refreshRunning) return;
  const settings = getSiteSettings();
  const now = Date.now();
  const due = {
    trump: now - Math.max(modifiedAt(TRUMP), lastRefreshAttempt.trump) >= settings.tradingSquareTrumpRefreshMinutes * 60_000,
    duan: now - Math.max(modifiedAt(DUAN), lastRefreshAttempt.duan) >= settings.tradingSquareDuanRefreshMinutes * 60_000,
  };
  if (!due.trump && !due.duan) return;
  refreshRunning = true;
  if (due.trump) lastRefreshAttempt.trump = now;
  if (due.duan) lastRefreshAttempt.duan = now;
  try {
    await Promise.allSettled([
      due.duan ? fetch(`${origin}/api/trading-square/duan?refresh=1`, { cache: "no-store", signal: AbortSignal.timeout(60_000) }) : Promise.resolve(),
      due.trump ? fetch(`${origin}/api/trading-square/trump?refresh=1`, { cache: "no-store", signal: AbortSignal.timeout(60_000) }) : Promise.resolve(),
    ]);
  } finally { refreshRunning = false }
}

export async function GET() {
  const settings = getSiteSettings();
  const translations = readJsonFile<Record<string, string>>(TRANSLATIONS, {});
  const trump = readJsonFile<CachedPost[]>(TRUMP, []).map(post => translations[post.id] ? { ...post, textZh: translations[post.id], author: "trump" as const } : { ...post, author: "trump" as const });
  const duan = readJsonFile<CachedPost[]>(DUAN, []).map(post => ({ ...post, author: "duan" as const }));
  const posts = [...trump, ...duan].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const updatedAt = Math.max(modifiedAt(TRUMP), modifiedAt(TRANSLATIONS), modifiedAt(DUAN));
  after(() => refreshInBackground(`http://127.0.0.1:${process.env.PORT || "3000"}`));
  return NextResponse.json({ posts, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, source: "local-cache", refreshMinutes: { trump: settings.tradingSquareTrumpRefreshMinutes, duan: settings.tradingSquareDuanRefreshMinutes } }, { headers: { "Cache-Control": "private, max-age=10, stale-while-revalidate=60" } });
}
