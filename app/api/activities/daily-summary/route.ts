import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  const row = getDb().prepare(`SELECT COUNT(*) AS trades, COALESCE(SUM(realized_pnl), 0) AS realized FROM trade_orders WHERE user_id = ? AND status = 'filled' AND traded_at >= ? AND traded_at < ?`).get(user.id, start.toISOString(), end.toISOString()) as { trades: number; realized: number };
  return NextResponse.json({ date: start.toISOString().slice(0, 10), trades: Number(row.trades || 0), realized: Number(row.realized || 0), currency: "原币种合计", settlement: "前一自然日 UTC 结算" });
}
