import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { proxyFetch } from "@/lib/net";

export const dynamic = "force-dynamic";

type Session = "PRE" | "REGULAR" | "AFTER";
interface Point { date: string; time: string; price: number; volume: number; session: Session }
const cache = new Map<string, { at: number; points: Point[] }>();
const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

function nyParts(timestamp: number) {
  const values: Record<string, string> = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(timestamp * 1000)).forEach((part) => { values[part.type] = part.value; });
  const hour = Number(values.hour) % 24;
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${String(hour).padStart(2, "0")}:${values.minute}`, minute: hour * 60 + Number(values.minute) };
}

export async function GET(request: Request) {
  if (!rateLimit(`session-day:${clientIp(request)}`, 90, 60000) || !rateLimitGlobal("session-day", 500, 60000)) return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  const url = new URL(request.url);
  const market = String(url.searchParams.get("market") || "").toUpperCase();
  const code = String(url.searchParams.get("code") || "").toUpperCase().replace(/\.(OQ|N|AM|PS|K)$/, "");
  if (market !== "US") return NextResponse.json({ error: "扩展时段首版仅支持美股" }, { status: 400 });
  if (!/^[A-Z0-9._-]{1,40}$/.test(code)) return NextResponse.json({ error: "股票代码不合法" }, { status: 400 });
  const cached = cache.get(code);
  if (cached && Date.now() - cached.at < 30000) return NextResponse.json({ market, code, points: cached.points, source: "Yahoo Finance extended hours" });
  try {
    interface YahooRaw {
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null>; volume?: Array<number | null> }> };
    }
    let result: YahooRaw | null = null;
    for (const host of YAHOO_HOSTS) {
      try {
        const response = await proxyFetch(`https://${host}/v8/finance/chart/${encodeURIComponent(code)}?interval=1m&range=1d&includePrePost=true&events=div%2Csplits`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(7000) });
        if (!response.ok) throw new Error("Yahoo response failed");
        result = (await response.json())?.chart?.result?.[0] ?? null;
        if (result) break;
      } catch {
        /* 当前主机失败，切下一个 */
      }
    }
    if (!result) throw new Error("Yahoo unreachable");
    const timestamps: number[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const quote = result?.indicators?.quote?.[0] || {};
    const closes: Array<number | null> = Array.isArray(quote.close) ? quote.close : [];
    const volumes: Array<number | null> = Array.isArray(quote.volume) ? quote.volume : [];
    const points: Point[] = [];
    timestamps.forEach((timestamp, index) => {
      const price = Number(closes[index]);
      if (!Number.isFinite(price) || price <= 0) return;
      const local = nyParts(timestamp);
      let session: Session | null = null;
      if (local.minute >= 240 && local.minute < 570) session = "PRE";
      else if (local.minute >= 570 && local.minute <= 960) session = "REGULAR";
      else if (local.minute > 960 && local.minute < 1200) session = "AFTER";
      if (session) points.push({ date: local.date, time: local.time, price, volume: Number(volumes[index]) || 0, session });
    });
    if (!points.length) throw new Error("empty extended hours");
    cache.set(code, { at: Date.now(), points });
    return NextResponse.json({ market, code, points, source: "Yahoo Finance extended hours", coverage: { pre: "04:00-09:29", regular: "09:30-16:00", after: "16:01-19:59", overnight: false } });
  } catch {
    return NextResponse.json({ error: "扩展时段行情获取失败" }, { status: 502 });
  }
}
