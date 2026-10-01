import { fail, ok } from "./api";
import { buildMarketCalendar, isCalendarMarket, MARKET_CALENDAR_SCHEMA_VERSION, MARKET_CALENDAR_VERSION } from "./marketCalendar";

export function marketCalendarResponse(request: Request) {
  const params = new URL(request.url).searchParams;
  const market = params.get("market") || "", rawYear = params.get("year") || "";
  if (params.getAll("market").length !== 1 || params.getAll("year").length !== 1 || !isCalendarMarket(market) || !/^\d{4}$/.test(rawYear) || Number(rawYear) < 2000 || Number(rawYear) > 2100) {
    return fail(40001, "market 必须为 CN、HK 或 US；year 必须为 2000–2100 的四位年份", 400);
  }
  const etag = `"market-calendar-${MARKET_CALENDAR_SCHEMA_VERSION}-${MARKET_CALENDAR_VERSION}-${market}-${rawYear}"`;
  const headers = { "Cache-Control": "public, max-age=300, must-revalidate", ETag: etag, Vary: "Origin, Authorization" };
  const tags = (request.headers.get("if-none-match") || "").split(",").map(item => item.trim().replace(/^W\//, ""));
  if (tags.includes(etag) || tags.includes("*")) return new Response(null, { status: 304, headers });
  const response = ok(buildMarketCalendar(market, Number(rawYear)));
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
