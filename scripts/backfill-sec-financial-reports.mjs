/* 从 SEC EDGAR 补齐「持仓/自选里的美股」近一年财报（最新 10-K + 最近 4 个 10-Q）。
 * 用法：
 *   node scripts/backfill-sec-financial-reports.mjs --dry-run   # 只探测能补哪些，不下载不写库
 *   node scripts/backfill-sec-financial-reports.mjs             # 实际下载并存库（幂等，跳过已存在）
 * 说明：
 *   - 数据源：SEC EDGAR（官方）。10-K=年报、10-Q=单季报。
 *   - 美股的 Q4 不单独发 10-Q，而是纳入年度 10-K（所以每财年通常只有 3 个 10-Q + 1 个 10-K）。
 *   - 仅对真正有 10-K/10-Q 的公司录入；ETF/杠杆基金/未上市公司（查不到 CIK 或无 10-Q/10-K）自动跳过。
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { execSync } from "child_process";

const UA = "FireFinance admin@example.com";
const DB_PATH = path.join(process.cwd(), "data", "fire.db");
const REPORTS_ROOT = path.join(process.cwd(), "public", "uploads", "reports");
const TMP = "/tmp/sec-backfill";
const EXCHANGE_NORM = { Nasdaq: "NASDAQ", NYSE: "NYSE", AMEX: "AMEX", NMS: "NASDAQ" };

const arg = process.argv.find((a) => a.startsWith("--"));
const DRY_RUN = arg === "--dry-run";

function pad10(n) { return String(n).padStart(10, "0"); }
function normSymbol(code) {
  // 去掉交易所后缀（.AM/.N/.OQ/.PS/.K 等），取基础代码
  const base = String(code || "").trim().toUpperCase();
  return base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}
async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.text();
}

/* 根据公司财政年末月推导 fiscalYear + fiscalPeriod。
 * fyEndMonth：来自最新 10-K 的 reportDate 月份（公司财政年末）。
 * 规则：fiscalYear = year(periodEnd) + (month(periodEnd) > fyEndMonth ? 1 : 0)
 *       季度 = 以财政年起始月(fyEndMonth+1)为 Q1 起点的位置。 */
function fiscalLabel(periodEnd, fyEndMonth, fyEndDay, isAnnual) {
  const d = new Date(periodEnd + "T00:00:00Z");
  const m = d.getUTCMonth() + 1;
  if (isAnnual) return { fiscalYear: d.getUTCFullYear(), fiscalPeriod: "FY" };
  const fyYear = d.getUTCFullYear() + (m > fyEndMonth ? 1 : 0);
  const fyStartMonth = m > fyEndMonth ? fyEndMonth + 1 : fyEndMonth + 1;
  const offset = (m - fyStartMonth + 12) % 12;
  const quarter = Math.floor(offset / 3) + 1;
  const period = "Q" + quarter;
  return { fiscalYear: fyYear, fiscalPeriod: period };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const db = new Database(DB_PATH, { fileMustExist: true });
  // 1) 取持仓/自选里的美股代码（去交易所后缀）
  const rows = db.prepare(
    `SELECT DISTINCT code FROM records WHERE market = 'US'`
  ).all();
  const symbols = [...new Set(rows.map((r) => normSymbol(r.code)))].filter(Boolean);
  console.log(`共 ${symbols.length} 个股代码（去后缀后）: ${symbols.join(", ")}`);

  // 2) ticker → {cik, exchange, name}
  const exRows = await fetchJson("https://www.sec.gov/files/company_tickers_exchange.json");
  const cols = exRows.fields;
  const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
  const tickerMap = {};
  for (const r of exRows.data) {
    const tick = String(r[idx.ticker]).trim().toUpperCase();
    if (!tick || tickerMap[tick]) continue;
    tickerMap[tick] = {
      cik: String(r[idx.cik]),
      exchange: EXCHANGE_NORM[String(r[idx.exchange])] || "NASDAQ",
      name: String(r[idx.name] || ""),
    };
  }

  // 3) 已有记录（幂等）
  const existing = new Set(
    db.prepare(`SELECT company_code, fiscal_year, fiscal_period, report_type FROM financial_report_files WHERE market='US'`)
      .all()
      .map((r) => `${r.company_code}|${r.fiscal_year}|${r.fiscal_period}|${r.report_type}`)
  );

  let planned = 0, skippedNoCik = 0, skippedFund = 0, done = 0, failed = 0;
  const added = [];

  // 基金/ETF 公司名特征（这些不是「top 股票」，不补 10-K/10-Q）
  const FUND_RE = /trust|proshares|direxion|wisdomtree|invesco|van.?eck|ishares|global x|amplify|grayscale|roundhill|fund/i;

  for (const sym of symbols) {
    const info = tickerMap[sym];
    if (!info) { skippedNoCik++; if (!DRY_RUN) console.log(`  - ${sym}: 无 CIK，跳过`); continue; }
    if (FUND_RE.test(info.name)) { skippedFund++; if (!DRY_RUN) console.log(`  - ${sym}: 基金/ETF(${info.name})，跳过`); continue; }
    let sub;
    try {
      sub = await fetchJson(`https://data.sec.gov/submissions/CIK${pad10(info.cik)}.json`);
    } catch (e) {
      console.log(`  ! ${sym}: 拉取提交列表失败 ${e.message}`); failed++; continue;
    }
    const rSub = sub.filings.recent || { form: [], filingDate: [], reportDate: [], accessionNumber: [], primaryDocument: [] };
    const kForm = rSub.form, kFileDate = rSub.filingDate, kReportDate = rSub.reportDate, kAcc = rSub.accessionNumber, kDoc = rSub.primaryDocument;

    const picks = [];
    let fyEndMonth = 12, fyEndDay = 31, latestAnnualReport = null;
    // 找最新年报（10-K 或 20-F）以锚定财政年末月
    for (let i = 0; i < kForm.length; i++) {
      if (kForm[i] === "10-K" || kForm[i] === "20-F") {
        latestAnnualReport = kReportDate[i] || null;
        if (latestAnnualReport) {
          const d = new Date(latestAnnualReport + "T00:00:00Z");
          fyEndMonth = d.getUTCMonth() + 1; fyEndDay = d.getUTCDate();
        }
        break;
      }
    }
    // 收集年报(10-K/20-F) + 单季报(10-Q)。recent 数组本身按提交日期倒序。
    const annual = [], qtr = [];
    for (let i = 0; i < kForm.length; i++) {
      const form = kForm[i];
      if (!kDoc[i]) continue;
      if (form === "10-K" || form === "20-F") annual.push(i);
      else if (form === "10-Q") qtr.push(i);
    }
    if (annual.length) picks.push({ idx: annual[0], isAnnual: true });     // 最新年报（倒序第一个）
    for (let n = 0; n < Math.min(4, qtr.length); n++) picks.push({ idx: qtr[n], isAnnual: false });

    if (!picks.length) { if (!DRY_RUN) console.log(`  - ${sym}: 无 10-K/20-F/10-Q`); continue; }

    for (const { idx, isAnnual } of picks) {
      const acc = kAcc[idx], doc = kDoc[idx], reportDate = kReportDate[idx] || "", filingDate = kFileDate[idx] || "";
      if (!acc || !doc || !reportDate) continue;
      const label = fiscalLabel(reportDate, fyEndMonth, fyEndDay, isAnnual);
      const key = `${sym}|${label.fiscalYear}|${label.fiscalPeriod}|${isAnnual ? "年度报告" : "季度报告"}`;
      if (existing.has(key)) { if (!DRY_RUN) console.log(`  = ${sym} ${label.fiscalYear}${label.fiscalPeriod}: 已存在，跳过`); continue; }
      planned++;
      if (DRY_RUN) continue;

      const fileUrlOrig = `https://www.sec.gov/Archives/edgar/data/${info.cik}/${acc.replace(/-/g, "")}/${doc}`;
      const html = await fetchText(fileUrlOrig);
      const safeName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.htm`;
      const relDir = path.join("uploads", "reports", "US", info.exchange, sym, String(label.fiscalYear), label.fiscalPeriod);
      const diskDir = path.join(process.cwd(), "public", relDir);
      fs.mkdirSync(diskDir, { recursive: true });
      fs.writeFileSync(path.join(diskDir, safeName), html, "utf8");
      const url = "/" + relDir.split(path.sep).join("/") + "/" + safeName;
      const id = `fr-${crypto.randomBytes(10).toString("hex")}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO financial_report_files (id,market,exchange,company_code,company_name,fiscal_year,fiscal_period,report_type,file_kind,file_name,file_url,mime_type,file_size,source,schema_version,uploaded_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, "US", info.exchange, sym, info.name || sym, label.fiscalYear, label.fiscalPeriod, isAnnual ? "年度报告" : "季度报告", "filing", doc, url, "text/html", Buffer.byteLength(html, "utf8"), "sec", "1.0", "system", now);
      existing.add(key);
      added.push(`${sym} ${label.fiscalYear}${label.fiscalPeriod}${isAnnual ? "(年)" : ""}`);
      done++;
      await sleep(120); // 节流，避免触发 SEC 限流
    }
    console.log(`  + ${sym} (${info.exchange}): 待补 ${picks.length}`);
    await sleep(150);
  }

  db.close();
  console.log(`\n=== 汇总 ===`);
  console.log(`无 CIK 跳过: ${skippedNoCik}`);
  console.log(`基金/ETF 跳过: ${skippedFund}`);
  console.log(`新增录入: ${done}`);
  console.log(`计划(含dry-run): ${planned}`);
  console.log(`失败: ${failed}`);
  if (added.length) console.log(`明细: ${added.join(", ")}`);
}
main().catch((e) => { console.error("脚本失败:", e); process.exit(1); });
