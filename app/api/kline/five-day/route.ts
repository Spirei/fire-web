import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

interface Point { date: string; time: string; price: number; volume: number }

function nyParts(timestamp: number) {
  const values: Record<string, string> = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(timestamp * 1000)).forEach((part) => { values[part.type] = part.value; });
  const hour = Number(values.hour) % 24;
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${String(hour).padStart(2, "0")}:${values.minute}`, minute: hour * 60 + Number(values.minute) };
}

async function yahooFiveDay(code: string): Promise<Point[]> {
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}?interval=5m&range=5d&includePrePost=false`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) return [];
  const result = (await response.json().catch(() => null))?.chart?.result?.[0];
  const timestamps: number[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const closes: Array<number | null> = Array.isArray(quote.close) ? quote.close : [];
  const volumes: Array<number | null> = Array.isArray(quote.volume) ? quote.volume : [];
  const points: Point[] = [];
  timestamps.forEach((timestamp, index) => {
    const price = Number(closes[index]); const local = nyParts(timestamp);
    if (!Number.isFinite(price) || price <= 0 || local.minute < 570 || local.minute > 960) return;
    points.push({ date: local.date, time: local.time, price, volume: Number(volumes[index]) || 0 });
  });
  return points;
}

export async function GET(request: Request) {
  if (!rateLimit(`kline-five:${clientIp(request)}`, 90, 60000) || !rateLimitGlobal("kline-five", 500, 60000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const url = new URL(request.url);
  const market = String(url.searchParams.get("market") || "").toUpperCase();
  const code = String(url.searchParams.get("code") || "").toUpperCase().replace(/\.(OQ|N|AM|PS|K)$/, "");
  if (market !== "US") return NextResponse.json({ error: "五日分钟行情首版仅支持美股" }, { status: 400 });
  if (!/^[A-Z0-9._-]{1,40}$/.test(code)) return NextResponse.json({ error: "股票代码不合法" }, { status: 400 });
  try {
    const response = await fetch(`https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_five=/US_MinlineNService.getMinline?symbol=${encodeURIComponent(code)}&day=5`, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" }, signal: AbortSignal.timeout(12000) });
    const text = await response.text();
    const match = text.match(/\(\"([\s\S]*)\"\)\s*;?\s*$/);
    if (!match) throw new Error("invalid response");
    let currentDate = "";
    const points: Point[] = [];
    // 新浪把下一交易日日期直接拼在上一日 16:00 行尾（"...303.4200 2026-08-04,09:30..."），
    // 先补成显式分隔符，否则后四天会被错误标记为首日。
    const normalized = match[1].replace(/\s+(\d{4}-\d{2}-\d{2})(?=,)/g, ";$1");
    for (const raw of normalized.split(";")) {
      const fields = raw.trim().split(",");
      if (fields.length < 4) continue;
      let offset = 0;
      if (/^\d{4}-\d{2}-\d{2}$/.test(fields[0])) { currentDate = fields[0]; offset = 1; }
      const time = fields[offset];
      const volume = Number(fields[offset + 1]);
      const price = Number(fields[offset + 3]);
      if (!currentDate || !/^\d{2}:\d{2}:\d{2}$/.test(time) || !Number.isFinite(price) || price <= 0) continue;
      points.push({ date: currentDate, time: time.slice(0, 5), price, volume: Number.isFinite(volume) ? volume : 0 });
    }
    if (points.length < 5) throw new Error("empty response");
    return NextResponse.json({ market, code, points, source: "Sina US five-day minute" });
  } catch {
    const points = await yahooFiveDay(code).catch(() => []);
    if (points.length) return NextResponse.json({ market, code, points, source: "Yahoo US five-day minute fallback" });
    return NextResponse.json({ error: "五日分钟行情获取失败" }, { status: 502 });
  }
}
