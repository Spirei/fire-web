import { getAuthUser } from "@/lib/auth";
import { getDividends, withPeriodYields } from "@/lib/dividends";
import { inspectHoldingDividends, settleRecordDividends } from "@/lib/dividendSettlement";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const MARKETS = ["US", "HK", "CN"];

/** v1 股息记录（富途公司行动-分红派息，带缓存） */
export async function GET(request: Request) {
  if (!rateLimit(`dividends:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("dividends", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const market = String(searchParams.get("market") ?? "").trim().toUpperCase();
  const code = String(searchParams.get("code") ?? "").trim().toUpperCase();
  if (!MARKETS.includes(market)) return fail(40001, "暂不支持该市场", 400);
  if (!/^[A-Z0-9._-]{1,40}$/.test(code)) return fail(40001, "股票代码不合法", 400);

  const { ok: sourceOk, dividends: raw } = await getDividends(market, code);
  const dividends = sourceOk ? await withPeriodYields(market, code, raw) : raw;
  const recordId = String(searchParams.get("recordId") ?? "").trim();
  let holding: ReturnType<typeof inspectHoldingDividends> | null = null;
  if (recordId) {
    const user = getAuthUser(request);
    if (!user) return fail(40101, "未登录", 401);
    holding = inspectHoldingDividends(user.id, recordId, dividends);
  }
  return ok({
    market,
    code,
    source: sourceOk ? (market === "CN" ? "eastmoney" : "futu") : "unavailable",
    dividends,
    holding
  });
}

/** 为当前持仓补齐已到派息日、尚未入账的股息记录。 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!rateLimit(`dividends-settle:${user.id}`, 20, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const body = await request.json().catch(() => null);
  const recordId = String(body?.recordId || "").trim();
  if (!recordId) return fail(40001, "缺少持仓记录", 400);
  try {
    const created = await settleRecordDividends(user.id, recordId);
    return ok({ created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "补录失败";
    return fail(message.includes("不存在") ? 40401 : 40001, message, message.includes("不存在") ? 404 : 400);
  }
}
