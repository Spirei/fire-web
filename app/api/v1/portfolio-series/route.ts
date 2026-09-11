import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { fetchDailyKline } from "@/lib/kline";
import { listOrders } from "@/lib/orders";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { listRecords } from "@/lib/store";

export const dynamic = "force-dynamic";

/** 组合时间序列的原始素材：一次把「全部持仓日K + 订单」取回（基准单独走 /api/kline/full 的小请求）。
 *  资产分析与资产盈亏分析共用（此前是浏览器按持仓逐只打 /api/kline/full，17 只 ≈ 17 次请求 / 700KB）。 */
const MARKETS = new Set(["US", "HK", "CN", "JP", "KR"]);

async function mapLimit<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(size, 1), items.length || 1) }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        await worker(current);
      }
    })
  );
}

export async function GET(request: Request) {
  if (!rateLimit(`portfolio-series:${clientIp(request)}`, 40, 60 * 1000) || !rateLimitGlobal("portfolio-series", 120, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const days = Math.min(1200, Math.max(60, Number(params.get("days")) || 330));

  const positions = listRecords(user.id).filter(
    (record) => Number(record.qty) > 0 && MARKETS.has(String(record.market || "").toUpperCase())
  );

  const closes: Record<string, { d: string; c: number }[]> = {};
  await mapLimit(positions, 6, async (record) => {
    try {
      const items = await fetchDailyKline(record.market, record.code, days);
      if (items.length > 0) closes[record.id] = items.map((item) => ({ d: item.d, c: item.c }));
    } catch {
      /* 单只失败不影响整体，前端会按缺数据处理 */
    }
  });

  // 订单面板与时间加权共用同一份数据（服务端直接读库，省掉一次 HTTP）
  const orders = listOrders(user.id, "all", 5000);
  return NextResponse.json(
    { closes, orders, days, at: Date.now() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
