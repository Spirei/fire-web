import { getAuthUser } from "@/lib/auth";
import { listRecords } from "@/lib/store";
import { fail, ok } from "@/lib/api";
import { getRates } from "@/lib/rates";
import { fetchOverviewQuotes } from "@/lib/quotes";
import { trackQuoteRequest } from "@/lib/quoteSubscriptionRequests";
import { buildOverview } from "@/lib/overview";
import { readAccountCash } from "@/lib/accountCashStore";
import { getDb } from "@/lib/db";

/** All monetary fields, including byMarket, are converted to currency (USD by default). */
export async function GET(request: Request) {
  try { return await overview(request); }
  catch { return fail(50001, "资产暂时无法读取，请稍后重试", 500); }
}

async function overview(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const rates = await getRates();
  const currency = new URL(request.url).searchParams.get("currency")?.toUpperCase() || "USD";
  if (!Number.isFinite(rates[currency]) || rates[currency] <= 0) return fail(40001, "不支持的汇总币种", 400);
  const records = listRecords(user.id);
  const items = records.filter(r => Number(r.qty) > 0);
  const tracked = await trackQuoteRequest(request, items);
  const snapshot = await fetchOverviewQuotes(items, 1_500, { tracked });
  // Read again after quote I/O, so account writes cannot leave an old holdings/new cash pair.
  return getDb().transaction(() => {
    if (!getAuthUser(request)) return fail(40101, "登录或连接已失效", 401);
    const current = listRecords(user.id);
    const active = current.filter(record => Number(record.qty) > 0);
    const original = new Map(records.map(record => [record.id, `${record.market}:${record.code}`]));
    const currentQuotes = Object.fromEntries(active.filter(record => original.get(record.id) === `${record.market}:${record.code}` && snapshot.quotes[record.id]).map(record => [record.id, snapshot.quotes[record.id]]));
    return ok({ ...buildOverview(current, rates, currentQuotes, currency, readAccountCash(user.id)),
      quoteStatus: { pending: snapshot.pending, cached: snapshot.cached.filter(id => currentQuotes[id]),
        missing: active.filter(record => !currentQuotes[record.id]).map(record => record.id) }
    });
  })();
}
