import { NextResponse } from "next/server";
import { searchStocks } from "@/lib/quotes";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { proxyFetch } from "@/lib/net";

export async function GET(request: Request) {
  if (!rateLimit(`search:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("search", 300, 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });
  if (q.length > 50) return NextResponse.json({ error: "搜索关键词过长" }, { status: 400 });

  try {
    const results = await searchStocks(q);
    let cryptoResults: unknown[] = [];
    try {
      const res = await proxyFetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { coins?: { id?: string; symbol?: string; name?: string }[] } | null;
        const priority: Record<string, number> = { BTC: 0, ETH: 1, BNB: 2, SOL: 3, XRP: 4, ADA: 5, DOGE: 6, AVAX: 7, DOT: 8, LINK: 9 };
        cryptoResults = (data?.coins ?? []).map((c) => ({ symbol: `CRYPTO:${String(c.id ?? c.symbol ?? "").toLowerCase()}`, code: String(c.symbol ?? "").toUpperCase(), name: String(c.name ?? "").trim(), market: "ASSET", price: null, changePct: null, type: "crypto", rank: priority[String(c.symbol ?? "").toUpperCase()] ?? 99 })).filter((c) => c.code && c.name).sort((a, b) => a.rank - b.rank).slice(0, 5).map(({ rank: _rank, ...c }) => c);
      }
    } catch { /* crypto source is optional */ }
    return NextResponse.json({ results: [...results, ...cryptoResults] });
  } catch (err) {
    return NextResponse.json({ error: "搜索失败，请稍后重试" }, { status: 502 });
  }
}
