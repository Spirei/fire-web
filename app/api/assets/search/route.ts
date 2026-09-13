import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/net";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { isMainstreamCryptoCode } from "@/lib/mainstreamCrypto";

export const dynamic = "force-dynamic";

/** 贵金属内置主流产品（搜索即添加候选） */
const METAL_CANDIDATES = [
  { code: "GOLD", name: "黄金", market: "ASSET", iconUrl: "https://companiesmarketcap.com/img/company-logos/64/GOLD.XM.png" },
  { code: "SILVER", name: "白银", market: "ASSET", iconUrl: "https://companiesmarketcap.com/img/company-logos/64/SILVER.XM.png" },
  { code: "PLAT", name: "铂金", market: "ASSET", iconUrl: "https://companiesmarketcap.com/img/company-logos/64/PLAT.XM.png" },
  { code: "PALLAD", name: "钯金", market: "ASSET", iconUrl: "https://companiesmarketcap.com/img/company-logos/64/PALLAD.XM.png" }
];

/**
 * 素材库「搜索即添加」候选：
 *  - crypto：CoinGecko 搜索（返回 名称 / 代码 / 大图图标 URL，走代理）
 *  - metal：内置四大贵金属按名称 / 代码匹配
 */
export async function GET(request: Request) {
  if (!rateLimit(`assets-search:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("assets-search", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const type = String(searchParams.get("type") ?? "").trim();
  const q = String(searchParams.get("q") ?? "").trim();
  if (!q || !["crypto", "metal"].includes(type)) {
    return NextResponse.json({ candidates: [] });
  }

  if (type === "metal") {
    const ql = q.toLowerCase();
    const candidates = METAL_CANDIDATES.filter(
      (m) => m.name.toLowerCase().includes(ql) || m.code.toLowerCase().includes(ql)
    );
    return NextResponse.json({ candidates });
  }

  try {
    const res = await proxyFetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) throw new Error(`CoinGecko 返回 ${res.status}`);
    const data = (await res.json().catch(() => null)) as { coins?: { symbol?: string; name?: string; thumb?: string }[] } | null;
    const coins = data?.coins ?? [];
    const candidates = coins
      .filter((c) => isMainstreamCryptoCode(String(c.symbol ?? "")))
      .slice(0, 8)
      .map((c) => ({
        code: String(c.symbol ?? "").toUpperCase(),
        name: String(c.name ?? "").trim(),
        market: "ASSET",
        // 搜索接口只给 thumb 小图，换 large 拿大图本地化
        iconUrl: String(c.thumb ?? "").replace("/thumb/", "/large/")
      }))
      .filter((c) => c.code && c.name);
    return NextResponse.json({ candidates });
  } catch {
    return NextResponse.json({ error: "获取行情源失败，请稍后重试" }, { status: 502 });
  }
}
