import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { getWorldEconomyData, WORLD_ECONOMY_INDICATORS, type WorldEconomyIndicator } from "@/lib/worldEconomy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!rateLimit(`world-economy:${clientIp(request)}`, 80, 60_000) || !rateLimitGlobal("world-economy", 500, 60_000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const indicator = (searchParams.get("indicator") || "inflation") as WorldEconomyIndicator;
  const year = Math.min(new Date().getFullYear(), Math.max(1990, Number(searchParams.get("year")) || new Date().getFullYear() - 1));
  if (!(indicator in WORLD_ECONOMY_INDICATORS)) return NextResponse.json({ error: "指标参数无效" }, { status: 400 });
  try {
    const countries = await getWorldEconomyData(indicator, year);
    const g20 = countries.filter((item) => ["ARG", "AUS", "BRA", "CAN", "CHN", "FRA", "DEU", "IND", "IDN", "ITA", "JPN", "MEX", "RUS", "SAU", "ZAF", "KOR", "TUR", "GBR", "USA"].includes(item.code)).sort((a, b) => b.value - a.value);
    return NextResponse.json({ indicator, year, meta: WORLD_ECONOMY_INDICATORS[indicator], countries, g20, thresholds: [...WORLD_ECONOMY_INDICATORS[indicator].thresholds], source: "World Bank Open Data" });
  } catch {
    return NextResponse.json({ error: "全球经济数据暂不可用，请稍后重试" }, { status: 502 });
  }
}
