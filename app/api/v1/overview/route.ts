import { getAuthUser } from "@/lib/auth";
import { listRecords } from "@/lib/store";
import { fail, ok } from "@/lib/api";

/** v1 资产总览（需登录）：总成本 / 总市值 / 总盈亏 / 各市场分布，移动端首页一站式展示 */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const records = listRecords(user.id);
  const num = (v: number | "") => (v === "" || v === null || v === undefined ? 0 : Number(v));
  let totalCost = 0;
  let totalMarket = 0;
  let count = 0;
  const byMarket: Record<string, { count: number; cost: number; market: number; pnl: number }> = {};
  records.forEach((r) => {
    const qty = num(r.qty);
    const cost = num(r.cost);
    const price = num(r.price);
    if (qty <= 0) return;
    const costVal = cost * qty;
    const marketVal = price > 0 ? price * qty : costVal;
    totalCost += costVal;
    totalMarket += marketVal;
    count += 1;
    const m = byMarket[r.market] ?? { count: 0, cost: 0, market: 0, pnl: 0 };
    m.count += 1;
    m.cost += costVal;
    m.market += marketVal;
    m.pnl += marketVal - costVal;
    byMarket[r.market] = m;
  });
  const totalPnl = totalMarket - totalCost;
  return ok({
    count,
    totalCost: +totalCost.toFixed(2),
    totalMarket: +totalMarket.toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
    totalPnlPct: totalCost > 0 ? +((totalPnl / totalCost) * 100).toFixed(2) : 0,
    byMarket: Object.fromEntries(
      Object.entries(byMarket).map(([k, v]) => [
        k,
        {
          count: v.count,
          cost: +v.cost.toFixed(2),
          market: +v.market.toFixed(2),
          pnl: +v.pnl.toFixed(2)
        }
      ])
    )
  });
}
