import { getAuthUser } from "@/lib/auth";
import { listRecords } from "@/lib/store";
import { fail, ok } from "@/lib/api";
import { getRates } from "@/lib/rates";
import { fetchQuotes } from "@/lib/quotes";
import { buildOverview } from "@/lib/overview";

/** All monetary fields, including byMarket, are converted to currency (USD by default). */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const records = listRecords(user.id);
  const rates = await getRates();
  const currency = new URL(request.url).searchParams.get("currency")?.toUpperCase() || "USD";
  if (!Number.isFinite(rates[currency]) || rates[currency] <= 0) return fail(40001, "不支持的汇总币种", 400);
  const quotes = await fetchQuotes(records.filter(r => Number(r.qty) > 0)).catch(() => ({}));
  return ok(buildOverview(records, rates, quotes, currency));
}
