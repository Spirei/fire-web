import { NextResponse } from "next/server";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

type FactUnit = { fy?: number; fp?: string; form?: string; filed?: string; end?: string; val?: number; frame?: string };
type Facts = Record<string, { label?: string; units?: Record<string, FactUnit[]> }>;

const UA = "Fire financial-data/1.0 contact=admin@fire.local";
let tickerCache: { at: number; map: Record<string, number> } | null = null;
const factsCache = new Map<string, { at: number; data: unknown }>();

async function cikFor(code: string) {
  if (!tickerCache || Date.now() - tickerCache.at > 86400000) {
    const response = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("SEC ticker list failed");
    const raw = await response.json() as Record<string, { cik_str: number; ticker: string }>;
    tickerCache = { at: Date.now(), map: Object.fromEntries(Object.values(raw).map((row) => [row.ticker.toUpperCase(), row.cik_str])) };
  }
  return tickerCache.map[code.toUpperCase().replace(/\.(OQ|N|AM|PS|K)$/, "")];
}

function quarterly(facts: Facts, names: string[], unit = "USD") {
  const fact = names.map((name) => facts[name]).find(Boolean);
  const rows = fact?.units?.[unit] || [];
  const unique = new Map<string, FactUnit>();
  rows.filter((row) => row.end && row.val != null && row.fp !== "FY" && ["10-Q", "10-K"].includes(row.form || ""))
    .sort((a, b) => String(a.filed).localeCompare(String(b.filed)))
    .forEach((row) => unique.set(`${row.end}:${row.fp || ""}`, row));
  return [...unique.values()].sort((a, b) => String(a.end).localeCompare(String(b.end))).slice(-8)
    .map((row) => ({ period: row.end, fiscalYear: row.fy, fiscalPeriod: row.fp, value: row.val }));
}

export async function GET(request: Request) {
  if (!rateLimit(`financials:${clientIp(request)}`, 60, 60000) || !rateLimitGlobal("financials", 300, 60000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const url = new URL(request.url);
  const market = String(url.searchParams.get("market") || "").toUpperCase();
  const code = String(url.searchParams.get("code") || "").toUpperCase();
  if (market !== "US") return NextResponse.json({ market, code, supported: false, error: "当前首版仅支持美股 SEC 财报数据" });
  if (!/^[A-Z0-9._-]{1,40}$/.test(code)) return NextResponse.json({ error: "股票代码不合法" }, { status: 400 });
  try {
    const cik = await cikFor(code);
    if (!cik) return NextResponse.json({ error: "未找到 SEC 公司档案" }, { status: 404 });
    const key = String(cik).padStart(10, "0");
    let cached = factsCache.get(key);
    if (!cached || Date.now() - cached.at > 6 * 3600000) {
      const response = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${key}.json`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("SEC company facts failed");
      cached = { at: Date.now(), data: await response.json() };
      factsCache.set(key, cached);
    }
    const body = cached.data as { entityName?: string; facts?: { "us-gaap"?: Facts } };
    const facts = body.facts?.["us-gaap"] || {};
    const metrics = {
      revenue: quarterly(facts, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"]),
      grossProfit: quarterly(facts, ["GrossProfit"]),
      operatingIncome: quarterly(facts, ["OperatingIncomeLoss"]),
      netIncome: quarterly(facts, ["NetIncomeLoss", "ProfitLoss"]),
      eps: quarterly(facts, ["EarningsPerShareDiluted", "EarningsPerShareBasic"], "USD/shares"),
      assets: quarterly(facts, ["Assets"]),
      liabilities: quarterly(facts, ["Liabilities"]),
      cash: quarterly(facts, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]),
      operatingCashFlow: quarterly(facts, ["NetCashProvidedByUsedInOperatingActivities"]),
      capex: quarterly(facts, ["PaymentsToAcquirePropertyPlantAndEquipment"]),
      dividendsPerShare: quarterly(facts, ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"], "USD/shares")
      ,productRevenue: quarterly(facts, ["SalesRevenueProductsNet", "RevenueFromContractWithCustomerIncludingAssessedTax"])
      ,serviceRevenue: quarterly(facts, ["SalesRevenueServicesNet"])
      ,costOfRevenue: quarterly(facts, ["CostOfRevenue", "CostOfGoodsAndServicesSold"])
      ,rdExpense: quarterly(facts, ["ResearchAndDevelopmentExpense"])
      ,sgaExpense: quarterly(facts, ["SellingGeneralAndAdministrativeExpense"])
      ,incomeTax: quarterly(facts, ["IncomeTaxExpenseBenefit"])
    };
    return NextResponse.json({ supported: true, market, code, company: body.entityName || code, currency: "USD", source: "SEC Company Facts", metrics });
  } catch {
    return NextResponse.json({ error: "财务数据获取失败，请稍后重试" }, { status: 502 });
  }
}
