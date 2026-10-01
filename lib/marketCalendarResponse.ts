import { fail, ok } from "./api";
import { buildMarketCalendar, buildMarketCalendars, isCalendarMarket, MARKET_CALENDAR_SCHEMA_VERSION, MARKET_CALENDAR_VERSION } from "./marketCalendar";

function validYear(params: URLSearchParams) {
  const value = params.get("year") || "";
  return params.getAll("year").length === 1 && /^\d{4}$/.test(value) && Number(value) >= 2000 && Number(value) <= 2100;
}
function cachedCalendar(request: Request, cacheKey: string, payload: () => unknown) {
  const etag = `"market-calendar-${MARKET_CALENDAR_SCHEMA_VERSION}-${MARKET_CALENDAR_VERSION}-${cacheKey}"`;
  const headers = { "Cache-Control": "public, max-age=300, must-revalidate", ETag: etag, Vary: "Origin, Authorization" };
  const tags = (request.headers.get("if-none-match") || "").split(",").map(item => item.trim().replace(/^W\//, ""));
  if (tags.includes(etag) || tags.includes("*")) return new Response(null, { status: 304, headers });
  const response = ok(payload());
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
export function marketCalendarResponse(request: Request) {
  const params = new URL(request.url).searchParams;
  const market = params.get("market") || "", rawYear = params.get("year") || "";
  if (params.getAll("market").length !== 1 || !isCalendarMarket(market) || !validYear(params)) {
    return fail(40001, "market 必须为 CN、HK 或 US；year 必须为 2000–2100 的四位年份", 400);
  }
  return cachedCalendar(request, `${market}-${rawYear}`, () => buildMarketCalendar(market, Number(rawYear)));
}
export function marketCalendarBatchResponse(request: Request) {
  const params = new URL(request.url).searchParams;
  if (!validYear(params) || params.has("market") || params.has("markets")) {
    return fail(40001, "批量接口固定返回 CN、HK、US；只需传入 2000–2100 的四位 year", 400);
  }
  const rawYear = params.get("year")!;
  return cachedCalendar(request, `batch-${rawYear}`, () => buildMarketCalendars(Number(rawYear)));
}
