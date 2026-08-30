/**
 * 股息记录（富途公司行动-分红派息优先）。
 *
 * 数据源：富途 get_corporate_actions_dividends，覆盖美股 / 港股 / A股 / ETF 的
 * 派息与收益分配。解析「1股派息0.27USD」「末期息5.3港元」等声明文本得到
 * 每股金额与币种；实物分派 / 优先发售等非现金方案标记为 special 展示。
 * 结果缓存 SQLite（dividend_cache）：成功 24h / 失败 6h，避免每次切页签都连 OpenD。
 */
import { getDb } from "./db";
import { fetchFutuDividends, type FutuDividendRaw } from "./futuQuotes";

const OK_TTL_MS = 24 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

export type DividendKind = "cash" | "special";

export interface DividendRecord {
  pubDate: string | null;
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  statement: string;
  process: string | null;
  fiscalYear: string | null;
  amount: number | null;
  currency: string | null;
  kind: DividendKind;
}

function normalizeDate(raw?: string): string | null {
  if (!raw) return null;
  const m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(raw.trim());
  if (!m) return raw.trim();
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function parseStatement(statement: string): { amount: number | null; currency: string | null } {
  const m = /([\d.]+)\s*(USD|HKD|CNY|港元|港币|美元|人民币元|人民币)/i.exec(statement);
  if (!m) return { amount: null, currency: null };
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return { amount: null, currency: null };
  const raw = m[2].toUpperCase();
  const currency = raw.startsWith("USD") ? "USD" : raw.startsWith("HKD") || raw.includes("港") ? "HKD" : raw.startsWith("CNY") || raw.includes("人民") ? "CNY" : raw;
  return { amount, currency };
}

function classifyKind(statement: string): DividendKind {
  if (/实物分派|优先发售|每持有.*股.*获发|股份分派/.test(statement)) return "special";
  return "cash";
}

function normalize(raw: FutuDividendRaw): DividendRecord {
  const { amount, currency } = parseStatement(raw.statement || "");
  return {
    pubDate: normalizeDate(raw.pub_date),
    exDate: normalizeDate(raw.ex_date),
    recordDate: normalizeDate(raw.record_date),
    payDate: normalizeDate(raw.dividend_payable_date),
    statement: raw.statement || "",
    process: raw.process || null,
    fiscalYear: raw.fiscal_year == null || raw.fiscal_year === "" ? null : String(raw.fiscal_year),
    amount,
    currency,
    kind: classifyKind(raw.statement || "")
  };
}

/** 东方财富 A 股分红送配（富途不支持 A 股股息）：只取「实施分配」，每股 = 每10股派现 ÷ 10 */
async function fetchCnDividends(code: string): Promise<DividendRecord[]> {
  const qs =
    `reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE="${code}")` +
    `&pageNumber=1&pageSize=200&sortTypes=-1&sortColumns=EX_DIVIDEND_DATE&source=HSF10&client=PC`;
  const res = await fetch(`https://datacenter.eastmoney.com/securities/api/data/v1/get?${qs}`, {
    headers: { "User-Agent": UA, Referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`eastmoney ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    result?: { data?: Array<Record<string, unknown>> };
  } | null;
  const rows = data?.result?.data ?? [];
  const out: DividendRecord[] = [];
  for (const r of rows) {
    if (String(r.ASSIGN_PROGRESS || "").trim() !== "实施分配") continue;
    const pretax = Number(r.PRETAX_BONUS_RMB);
    const cash = Number.isFinite(pretax) && pretax > 0;
    const bonusRatio = Number(r.BONUS_RATIO) || 0;
    const itRatio = Number(r.IT_RATIO) || 0;
    const stock = bonusRatio > 0 || itRatio > 0;
    out.push({
      pubDate: normalizeDate(String(r.PLAN_NOTICE_DATE || r.PUBLISH_DATE || "")),
      exDate: normalizeDate(String(r.EX_DIVIDEND_DATE || "")),
      recordDate: normalizeDate(String(r.EQUITY_RECORD_DATE || "")),
      payDate: null,
      statement: String(r.IMPL_PLAN_PROFILE || ""),
      process: String(r.ASSIGN_PROGRESS || "") || null,
      fiscalYear: String(r.REPORT_DATE || "").slice(0, 4) || null,
      amount: cash ? pretax / 10 : null,
      currency: cash ? "CNY" : null,
      kind: cash && !stock ? "cash" : "special"
    });
  }
  return out;
}

interface CacheRow {
  payload: string;
  fetched_at: number;
}

/**
 * 个股 / ETF 股息记录。ok=false 表示富途当前不可用（未缓存，恢复后自动可取）；
 * ok=true 且 dividends 为空表示该标的确实没有（或暂无）派息记录（缓存 24h）。
 */
export async function getDividends(market: string, code: string): Promise<{ ok: boolean; dividends: DividendRecord[] }> {
  const m = market.trim().toUpperCase();
  const c = code.trim().toUpperCase();
  if (!m || !c) return { ok: true, dividends: [] };

  const db = getDb();
  const row = db.prepare("SELECT payload, fetched_at FROM dividend_cache WHERE market = ? AND code = ?").get(m, c) as CacheRow | undefined;
  const now = Date.now();
  if (row?.fetched_at) {
    const age = now - row.fetched_at;
    const parsed = JSON.parse(row.payload) as { ok: boolean; dividends?: DividendRecord[] };
    if (parsed.ok && age < OK_TTL_MS) return { ok: true, dividends: parsed.dividends ?? [] };
  }

  try {
    const dividends = m === "CN" ? await fetchCnDividends(c) : (await fetchFutuDividends(m, c)).map(normalize);
    db.prepare(
      `INSERT INTO dividend_cache (market, code, payload, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(market, code) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
    ).run(m, c, JSON.stringify({ ok: true, dividends }), now);
    return { ok: true, dividends };
  } catch {
    return { ok: false, dividends: [] };
  }
}
