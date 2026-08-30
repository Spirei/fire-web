import { NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { fetchIntraday, samplePoints, type Intraday } from "@/lib/quotes";
import { parseMarket } from "@/lib/store";
import type { QuoteItem } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function POST(request: Request) {
  if (!rateLimit(`charts:${clientIp(request)}`, 120, 60 * 1000) || !rateLimitGlobal("charts", 600, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (rawItems.length === 0) return NextResponse.json({ charts: {} });
  if (rawItems.length > 100) return NextResponse.json({ error: "单次最多获取 100 只走势" }, { status: 400 });

  const items: QuoteItem[] = rawItems
    .filter((item: { id?: unknown; market?: unknown; code?: unknown }) =>
      typeof item?.id === "string" && item.id.length <= 100 && typeof item?.code === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(item.code.trim())
    )
    .map((item: { id: string; market: string; code: string }) => ({
      id: item.id,
      market: parseMarket(item.market),
      code: item.code.trim()
    }));

  if (items.length === 0) return NextResponse.json({ error: "没有有效的股票代码" }, { status: 400 });

  try {
    const charts = await fetchIntraday(items);
    // 仅当请求方声明 sample 才抽 60 点（迷你走势图）；不带则返回全量（如个股详情 K线）。
    const doSample = body?.sample === true;
    const sampled: Record<string, Intraday> = {};
    for (const [id, c] of Object.entries(charts)) sampled[id] = { ...c, points: doSample ? samplePoints(c.points, 60) : c.points };
    const bodyOut = JSON.stringify({ charts: sampled });
    const acceptsGzip = /gzip/.test(request.headers.get("accept-encoding") || "");
    if (acceptsGzip) {
      const gz = gzipSync(bodyOut);
      return new Response(gz, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip",
          "Vary": "Accept-Encoding",
          "Cache-Control": "public, max-age=30"
        }
      });
    }
    return new Response(bodyOut, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30" }
    });
  } catch (err) {
    return NextResponse.json({ error: "走势数据获取失败，请稍后重试" }, { status: 502 });
  }
}
