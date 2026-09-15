import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { fetchQuotes } from "@/lib/quotes";
import { fillEtfMarketCaps } from "@/lib/etfMarketCap";
import { parseMarket } from "@/lib/store";
import type { QuoteItem } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function POST(request: Request) {
  // 公开行情接口限流：防未认证高频调用引发外部源站请求风暴
  if (!rateLimit(`quotes:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("quotes", 600, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) return NextResponse.json({ quotes: {} });
  if (rawItems.length > 100) return NextResponse.json({ error: "单次最多查询 100 只" }, { status: 400 });

  const items: QuoteItem[] = rawItems
    .filter((item: { id?: unknown; market?: unknown; code?: unknown }) =>
      typeof item?.id === "string" && item.id.length <= 100 && typeof item?.code === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(item.code.trim())
    )
    .map((item: { id: string; market: string; code: string }) => ({
      id: item.id,
      market: parseMarket(item.market),
      code: item.code.trim()
    }));

  if (items.length === 0) return NextResponse.json({ error: "没有有效的股票代码" }, { status: 400 });

  try {
    const quotes = await fetchQuotes(items);
    // 补 ETF 市值（与个股详情页 resolveEtfMarketCap 同源：东财基金规模/份额×价格，带缓存+预算）
    await fillEtfMarketCaps(items, quotes);
    return NextResponse.json({ quotes });
  } catch (err) {
    return NextResponse.json({ error: "行情获取失败，请稍后重试" }, { status: 502 });
  }
}
