import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
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
  // ETag 只按「内容」算（不含 at），刷新页面时命中就回 304，不再重传几十 KB；
  // 30 秒内浏览器可直接用本地副本，超过后走条件请求。
  // 指纹必须稳定：closes 是并发取回的，键顺序每次都可能不同，所以按 id 排序后再序列化；
  // 订单只取「会影响序列结果」的字段，避免无关字段（更新时间等）抖动导致 304 失效。
  const fingerprint = JSON.stringify({
    userId: user.id,
    days,
    closes: Object.keys(closes)
      .sort()
      .map((id) => [id, closes[id]]),
    orders: orders.map((order) => [
      order.id,
      order.recordId,
      order.market,
      order.side,
      order.qty,
      order.price,
      order.fees,
      order.amount,
      order.tradedAt,
      order.status,
      order.positionQtyBefore ?? null,
      order.positionQtyAfter ?? null
    ])
  });
  const etag = `W/"ps-${createHash("sha1").update(fingerprint).digest("hex").slice(0, 24)}"`;
  const headers = { ETag: etag, "Cache-Control": "private, max-age=30, must-revalidate" };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return NextResponse.json({ closes, orders, days, at: Date.now() }, { headers });
}
