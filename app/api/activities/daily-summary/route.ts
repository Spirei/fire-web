import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const today = new Date().toISOString().slice(0, 10);
  const row = getDb().prepare(`SELECT substr(traded_at, 1, 10) AS date, COUNT(*) AS trades, COALESCE(SUM(realized_pnl), 0) AS realized FROM trade_orders WHERE user_id = ? AND status = 'filled' AND substr(traded_at, 1, 10) < ? GROUP BY substr(traded_at, 1, 10) ORDER BY date DESC LIMIT 1`).get(user.id, today) as { date?: string; trades: number; realized: number } | undefined;
  if (!row?.date) return NextResponse.json({ date: "", trades: 0, realized: 0, markets: {}, currency: "原币种合计", settlement: "暂无已成交记录" });
  const marketRows = getDb().prepare(`SELECT market, COUNT(*) AS trades, COALESCE(SUM(realized_pnl), 0) AS realized FROM trade_orders WHERE user_id = ? AND status = 'filled' AND substr(traded_at, 1, 10) = ? GROUP BY market`).all(user.id, row.date) as { market: string; trades: number; realized: number }[];
  const markets = Object.fromEntries(marketRows.map((item) => [item.market, { trades: Number(item.trades), realized: Number(item.realized) }]));
  return NextResponse.json({ date: row.date, trades: Number(row.trades), realized: Number(row.realized), markets, currency: "原币种合计", settlement: "最近一个有成交记录的交易日" });
}
