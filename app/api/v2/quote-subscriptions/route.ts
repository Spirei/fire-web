import { appV2Response } from "@/lib/appApiV2";
import { fail, ok } from "@/lib/api";
import { getAuthUser } from "@/lib/auth";
import { quoteSubscriptionService } from "@/lib/quoteSubscriptionRequests";
import { publicQuoteItems, QUOTE_DEMAND_MARKETS } from "@/lib/quoteDemand";
import { readJsonBody, RequestBodyTooLargeError } from "@/lib/requestBody";
import { rateLimit } from "@/lib/rateLimit";
import type { QuoteItem } from "@/lib/quotes";

export const dynamic = "force-dynamic";
const supported = (market: unknown): market is string => typeof market === "string" &&
  QUOTE_DEMAND_MARKETS.includes(market as typeof QUOTE_DEMAND_MARKETS[number]);

function parseItems(body: unknown): QuoteItem[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "items") || !Array.isArray(value.items) ||
    value.items.length === 0 || value.items.length > 100) return null;
  const items: QuoteItem[] = [];
  for (const input of value.items) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => key !== "market" && key !== "code") || !supported(input.market) ||
      typeof input.code !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(input.code.trim())) return null;
    items.push({ market: input.market, code: input.code.trim(), id: "" });
  }
  const normalized = publicQuoteItems(items);
  return normalized.length ? normalized : null;
}

export function GET(request: Request) {
  return appV2Response(request, async () => {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "market") || params.getAll("market").length > 1)
      return fail(40001, "不支持的查询参数", 400);
    const market = params.get("market") ?? undefined;
    if (market !== undefined && !supported(market)) return fail(40001, "不支持的市场", 400);
    const service = await quoteSubscriptionService();
    const user = getAuthUser(request);
    if (!user) return fail(40101, "连接已失效", 401);
    if (!rateLimit(`quote-subscriptions:read:${user.id}`, 120, 60_000)) return fail(42901, "请求过于频繁", 429);
    return ok({ subscriptions: service.list(user.id, market) });
  });
}

async function mutate(request: Request, remove: boolean) {
  return appV2Response(request, async () => {
    // Body loading can yield; credentials are checked again immediately before the write.
    let body: unknown;
    try { body = await readJsonBody(request, 64 * 1024); }
    catch (error) {
      if (error instanceof RequestBodyTooLargeError) return fail(41301, "请求体过大", 413);
      return fail(40001, "请求体不合法", 400);
    }
    const all = remove && body !== null && typeof body === "object" && !Array.isArray(body) &&
      Object.keys(body).length === 1 && (body as { all?: unknown }).all === true;
    const items = all ? undefined : parseItems(body);
    if (!all && !items) return fail(40001, "请提供 1 至 100 个有效的 market / code", 400);
    if (new URL(request.url).search) return fail(40001, "不支持的查询参数", 400);
    const service = await quoteSubscriptionService();
    const user = getAuthUser(request);
    if (!user) return fail(40101, "连接已失效", 401);
    if (!rateLimit(`quote-subscriptions:write:${user.id}`, 60, 60_000)) return fail(42901, "请求过于频繁", 429);
    try {
      if (remove) service.remove(user.id, items ?? undefined);
      else service.subscribe(user.id, items!);
    } catch (error) {
      // Shared services may originate in a different Next entry's module cache.
      if ((error as { code?: string } | null)?.code === "QUOTE_SUBSCRIPTION_LIMIT")
        return fail(40901, "最多保留 256 个行情订阅", 409);
      throw error;
    }
    return ok({ subscriptions: service.list(user.id) });
  });
}
export function POST(request: Request) { return mutate(request, false); }
export function DELETE(request: Request) { return mutate(request, true); }
