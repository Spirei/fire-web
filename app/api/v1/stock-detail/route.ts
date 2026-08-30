import { fetchQuotes } from "@/lib/quotes";
import { fetchDailyKline } from "@/lib/kline";
import { getRates } from "@/lib/rates";
import { multiCurrencyCap, MARKET_CURRENCY } from "@/lib/currency";
import { resolveEtfMarketCap } from "@/lib/etfMarketCap";
import { FALLBACK_RATES } from "@/lib/types";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const MARKETS = ["US", "HK", "CN", "JP", "KR"];

/**
 * v1 个股详情（个股页数据契约，Web / iOS 共用）
 *
 * GET /api/v1/stock-detail?market=US&code=AAPL
 *
 * 返回：quote（完整实时行情）+ marketCap（六币种市值）+ rates + kline（日 K 前复权）。
 * 行情 / 汇率 / K 线三路并行拉取、互不阻塞：任一路失败只缺对应字段，不影响整页展示。
 * 鉴权：无（限流保护），与 v1 search / earnings 一致；移动端可登录后带 Bearer 调用。
 */
export async function GET(request: Request) {
  if (!rateLimit(`stock-detail:${clientIp(request)}`, 60, 60 * 1000) || !rateLimitGlobal("stock-detail", 300, 60 * 1000)) {
    return fail(42901, "请求过于频繁，请稍后再试", 429);
  }
  const { searchParams } = new URL(request.url);
  const market = String(searchParams.get("market") ?? "").trim().toUpperCase();
  const code = String(searchParams.get("code") ?? "").trim().toUpperCase();
  const includeKline = searchParams.get("includeKline") !== "0";
  if (!market || !code) return fail(40001, "缺少 market / code", 400);
  if (!/^[A-Z0-9._-]+$/.test(code)) return fail(40001, "股票代码不合法", 400);
  if (!MARKETS.includes(market)) return fail(40001, "暂不支持该市场", 400);

  const id = `${market}:${code}`;
  const [quoteRes, ratesRes, klineRes] = await Promise.allSettled([
    fetchQuotes([{ id, market, code }]),
    getRates(),
    includeKline ? fetchDailyKline(market, code, 320) : Promise.resolve([])
  ]);

  const quote = quoteRes.status === "fulfilled" ? quoteRes.value[id] ?? null : null;
  const rates = ratesRes.status === "fulfilled" && ratesRes.value ? ratesRes.value : { ...FALLBACK_RATES };
  const kline = klineRes.status === "fulfilled" ? klineRes.value : [];

  let marketCapRaw = quote?.marketCap ?? 0;
  // 富途/腾讯对美股 ETF 不返回总市值：用「份额 × 现价」补齐（详见 lib/etfMarketCap.ts）
  if (marketCapRaw <= 0 && quote?.price) {
    marketCapRaw = (await resolveEtfMarketCap(market, code, quote.price)) ?? 0;
  }
  const currency = MARKET_CURRENCY[market] || "USD";
  const marketCap = marketCapRaw > 0 ? multiCurrencyCap(market, marketCapRaw, rates) : null;

  return ok({
    market,
    code,
    name: quote?.name ?? null,
    currency,
    quote: quote
      ? {
          name: quote.name,
          price: quote.price,
          change: quote.change,
          changePct: quote.changePct,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          prevClose: quote.prevClose ?? quote.price - quote.change,
          session: quote.session ?? "REGULAR",
          volume: quote.volume ?? null,
          amount: quote.amount ?? null,
          pe: quote.pe ?? null,
          turnover: quote.turnover ?? null,
          amplitude: quote.amplitude ?? null,
          epsTtm: quote.epsTtm ?? null,
          weekHigh: quote.weekHigh ?? null,
          weekLow: quote.weekLow ?? null,
          pb: quote.pb ?? null,
          dividendYieldTtm: quote.dividendYieldTtm ?? null,
          volumeRatio: quote.volumeRatio ?? null,
          totalShares: quote.totalShares ?? null,
          floatShares: quote.floatShares ?? null,
          staticPe: quote.staticPe ?? null,
          dividendTtm: quote.dividendTtm ?? null,
          averagePrice: quote.averagePrice ?? null,
          marketCap: marketCapRaw > 0 ? marketCapRaw : null,
          time: quote.time
        }
      : null,
    marketCap,
    rates,
    kline
  });
}
