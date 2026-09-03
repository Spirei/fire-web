import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { fetchDailyKline } from "@/lib/kline";
import { marketSessionState } from "@/lib/marketSessions";
import { listRecords } from "@/lib/store";

const KLINE_MARKETS = new Set(["US", "HK", "CN", "JP", "KR"]);

type MarketAgg = { holdings: number; pnl: number; date: string };

async function poolMap<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(size, 1), items.length) }, () => run()));
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const positions = listRecords(user.id).filter((record) => Number(record.qty) > 0 && KLINE_MARKETS.has(String(record.market || "").toUpperCase()));
  const markets: Record<string, MarketAgg> = {};
  const dates = new Set<string>();

  await poolMap(positions, 5, async (record) => {
    const qty = Number(record.qty);
    const market = String(record.market).toUpperCase();
    try {
      const items = await fetchDailyKline(market, record.code, 16);
      const today = marketSessionState(market).localDate;
      let index = -1;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].d < today) {
          index = i;
          break;
        }
      }
      if (index < 1) return;
      const date = items[index].d;
      const pnl = (items[index].c - items[index - 1].c) * qty;
      const current = markets[market] ?? { holdings: 0, pnl: 0, date };
      current.holdings += 1;
      current.pnl += pnl;
      if (date > current.date) current.date = date;
      markets[market] = current;
      dates.add(date);
    } catch {
      /* 单只 K 线失败不影响其余持仓 */
    }
  });

  const dateList = [...dates].sort();
  const holdings = Object.values(markets).reduce((sum, item) => sum + item.holdings, 0);
  return NextResponse.json({
    date: dateList.length === 1 ? dateList[0] : dateList.length ? `${dateList[0]} ~ ${dateList[dateList.length - 1]}` : "",
    holdings,
    markets,
    settlement: "上一交易日收盘相对前收盘"
  });
}
