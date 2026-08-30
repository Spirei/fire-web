import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// 简单内存缓存：月收盘序列（10 分钟）
const cache = new Map<string, { closes: number[]; at: number }>();

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

// 把日 K 按自然月聚合为月收盘价（最近 12 个月）
function monthlyFromDaily(rows: { date: string; close: number }[]): number[] {
  const monthly = new Map<string, number>();
  rows.forEach((r) => {
    if (!/^\d{4}-\d{2}/.test(r.date) || !Number.isFinite(r.close) || r.close <= 0) return;
    monthly.set(r.date.slice(0, 7), r.close);
  });
  return [...monthly.values()].slice(-12);
}

export async function GET(request: Request) {
  if (!rateLimit(`kline:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("kline", 600, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get("market") || "").toUpperCase();
  const code = (searchParams.get("code") || "").toUpperCase();
  if (!code) return NextResponse.json({ error: "缺少代码" }, { status: 400 });
  // 代码白名单：仅允许字母 / 数字 / 点 / 下划线 / 连字符，防止 URL 参数注入
  if (!/^[A-Z0-9._-]+$/.test(code)) return NextResponse.json({ error: "股票代码不合法" }, { status: 400 });

  const key = `${market}:${code}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
    return NextResponse.json({ closes: cached.closes });
  }

  let closes: number[] = [];
  try {
    if (market === "CN") {
      const symbol = /^6/.test(code) ? `sh${code}` : `sz${code}`;
      const res = await fetch(
        `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=no&datalen=250`,
        { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) }
      );
      const text = await res.text();
      const m = text.match(/\((\[.*\])\)/s);
      if (m) {
        const arr = JSON.parse(m[1]) as { day: string; close: string }[];
        closes = monthlyFromDaily(arr.map((r) => ({ date: r.day, close: Number(r.close) })));
      }
    } else if (market === "US") {
      const res = await fetch(
        `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_=/US_MinKService.getDailyK?symbol=${encodeURIComponent(code)}&___qn=3`,
        { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" }, signal: AbortSignal.timeout(12000) }
      );
      const text = await res.text();
      const m = text.match(/\((\[.*\])\)/s);
      if (m) {
        const arr = JSON.parse(m[1]) as { d: string; c: string }[];
        closes = monthlyFromDaily(arr.slice(-250).map((r) => ({ date: r.d, close: Number(r.c) })));
      }
    }
    // 港股 / 日韩 / 加密 / 贵金属暂无可用月 K 数据源，返回空
  } catch {
    /* 数据源失败时返回空 */
  }
  cache.set(key, { closes, at: Date.now() });
  return NextResponse.json({ closes });
}
