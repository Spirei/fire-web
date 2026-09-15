import { readJsonBody } from "@/lib/requestBody";
import { fetchQuotes } from "@/lib/quotes";
import { fillEtfMarketCaps } from "@/lib/etfMarketCap";
import { parseMarket } from "@/lib/store";
import type { QuoteItem } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

/** v1 批量实时行情（单次最多 100 只） */
export async function POST(request: Request) {
  if (!rateLimit(`quotes:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("quotes", 600, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const body = await readJsonBody(request).catch(() => null);
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) return ok({ quotes: {} });
  if (rawItems.length > 100) return fail(40001, "单次最多查询 100 只", 400);
  const items: QuoteItem[] = rawItems
    .filter(
      (item: { id?: unknown; market?: unknown; code?: unknown }) =>
        typeof item?.id === "string" && item.id.length <= 100 && typeof item?.code === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(item.code.trim())
    )
    .map((item: { id: string; market: string; code: string }) => ({
      id: item.id,
      market: parseMarket(item.market),
      code: item.code.trim()
    }));
  if (items.length === 0) return fail(40001, "没有有效的股票代码", 400);
  try {
    const quotes = await fetchQuotes(items);
    await fillEtfMarketCaps(items, quotes);
    return ok({ quotes });
  } catch {
    return fail(50002, "行情获取失败，请稍后重试", 502);
  }
}
