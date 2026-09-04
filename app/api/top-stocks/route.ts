import { NextResponse } from "next/server";
import { getTopStocks, type TopMarket } from "@/lib/topStocks";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { getAssets } from "@/lib/assets";
import { enrichAssetQuotes, ensureAssetQuotesReady } from "@/lib/assetQuotes";

export const dynamic = "force-dynamic";

const MARKETS: TopMarket[] = ["US", "HK", "CN", "JP", "KR", "ALL"];

export async function GET(request: Request) {
  if (!rateLimit(`topstocks:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("topstocks", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const market = (searchParams.get("market") || "US").toUpperCase() as TopMarket;
  if (!MARKETS.includes(market)) {
    return NextResponse.json({ error: "market 参数无效" }, { status: 400 });
  }
  try {
    const result = await getTopStocks(market);
    if (market === "ALL") {
      await ensureAssetQuotesReady();
      const cryptoMetal = enrichAssetQuotes([...getAssets("crypto"), ...getAssets("metal")]);
      const extraItems = cryptoMetal
        .filter((asset) => (asset.type === "crypto" || asset.type === "metal") && Number.isFinite(asset.marketCap) && asset.marketCap > 0)
        .map((asset) => ({
          market: "ASSET" as const,
          code: asset.code,
          name: asset.name,
          marketCap: asset.marketCap || 0,
          price: asset.price,
          changePct: asset.changePct,
          logo: asset.url,
          type: asset.type as "crypto" | "metal"
        }));
      // 硬约束：全球预览不可有重复行。CMC「资产页」本身已含贵金属/加密货币（英文名），
      // 与素材库追加项合并时统一去重——贵金属/加密货币按 类型+代码，股票按 市场+代码，
      // 素材库版本优先（中文名 + 自定义图标），随后按市值排序取前 100。
      const seen = new Set<string>();
      const merged: typeof result.items = [];
      for (const it of [...extraItems, ...result.items]) {
        const key =
          it.type === "crypto" || it.type === "metal"
            ? `${it.type}:${it.code.toUpperCase()}`
            : `${it.market}:${it.code.toUpperCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(it);
      }
      result.items = merged
        .filter((item) => Number.isFinite(item.marketCap) && item.marketCap > 0)
        .sort((a, b) => b.marketCap - a.marketCap)
        .slice(0, 100);
    }
    return NextResponse.json({ market, ...result });
  } catch (err) {
    return NextResponse.json({ items: [], error: "获取市值排行失败，请稍后重试" }, { status: 502 });
  }
}
