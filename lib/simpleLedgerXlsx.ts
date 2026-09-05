// 有知有行「投资记账」xlsx 导出/导入 兼容工具
// 有知有行导出格式（一个账户一个 sheet）：
//   row1: 账户名称 | 账户目标 | 预期年化收益率 | 预计投资时间 | 币种 | 四笔钱
//   row2: <account 元数据值>
//   row3: 空
//   row4: 记录类型 | 记账时间 | 转入转出金额 | 总资产金额 | 投资日志 | 创建时间 | 明细
//   row5+: 记总资产 / 转入转出 记录
import * as XLSX from "xlsx";

export type XlsxHist = { d: string; v?: number | null; inn?: number; out?: number };
export type XlsxInvest = {
  id?: string;
  name: string;
  cur?: string;
  amount?: number;
  bucket?: string;
  market?: string;
  expected?: number;
  inAmt?: number;
  outAmt?: number;
  updated?: string;
  hist?: XlsxHist[];
};

const EP_1899 = Date.UTC(1899, 11, 30);

function serialToDate(n: number): string {
  const d = new Date(n * 86400000 + EP_1899);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dateToSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return 0;
  return (Date.UTC(y, (m || 1) - 1, d || 1) - EP_1899) / 86400000;
}

const CURRENCY_LABEL: Record<string, string> = {
  CNY: "人民币", USD: "美元", HKD: "港币", GBP: "英镑", EUR: "欧元", JPY: "日元",
  KRW: "韩元", SGD: "新加坡元", AUD: "澳元", CAD: "加元", INR: "印度卢比", TWD: "新台币", BRL: "巴西雷亚尔",
};
const CURRENCY_CODE: Record<string, string> = {
  人民币: "CNY", 美元: "USD", 港币: "HKD", 港元: "HKD", 英镑: "GBP", 欧元: "EUR", 日元: "JPY",
  韩元: "KRW", 新加坡元: "SGD", 澳元: "AUD", 加元: "CAD", 印度卢比: "INR", 新台币: "TWD", 巴西雷亚尔: "BRL", 雷亚尔: "BRL",
};
const MARKET_BY_CUR: Record<string, string> = {
  CNY: "CN", USD: "US", HKD: "HK", GBP: "UK", EUR: "DE", JPY: "JP",
  KRW: "KR", SGD: "SG", AUD: "AU", CAD: "CA", INR: "IN", TWD: "TW", BRL: "BR",
};

function fmtPct(v: number | undefined): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${(Math.round(n * 10) / 10).toFixed(1)}%` : "";
}
function parsePct(v: unknown): number {
  const s = String(v ?? "");
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) || 0 : 0;
}
function bucketToLabel(b: string | undefined): string {
  const s = b || "长期";
  if (s === "活钱") return "活钱管理";
  if (s === "稳健") return "稳健理财";
  return "长期投资";
}
function bucketFromLabel(l: string | undefined): string {
  const s = l || "长期投资";
  if (s.includes("活钱")) return "活钱";
  if (s.includes("稳健")) return "稳健";
  return "长期";
}
function curLabel(code: string | undefined): string {
  return CURRENCY_LABEL[code || ""] || (code || "人民币");
}
function curCode(label: string | undefined): string {
  return CURRENCY_CODE[label || ""] || "CNY";
}
function marketFromCur(code: string): string {
  return MARKET_BY_CUR[code] || "CN";
}
function sanitizeSheetName(name: string, idx: number): string {
  const cleaned = String(name || "").replace(/[\[\]:*?/\\]/g, "").slice(0, 31).trim();
  return cleaned || `账户${idx + 1}`;
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把 simple-app 的投资账户数组生成为「有知有行投资记账」格式 workbook */
export function buildYouzhiyouxingWorkbook(invest: XlsxInvest[]) {
  const wb = XLSX.utils.book_new();
  (invest || []).forEach((a, idx) => {
    const rows: unknown[][] = [];
    rows.push(["账户名称", "账户目标", "预期年化收益率", "预计投资时间", "币种", "四笔钱"]);
    rows.push([a.name, "", fmtPct(a.expected), "3年以上", curLabel(a.cur), bucketToLabel(a.bucket)]);
    rows.push([]);
    rows.push(["记录类型", "记账时间", "转入转出金额", "总资产金额", "投资日志", "创建时间", "明细"]);

    let hist = (a.hist || []).slice().sort((x, y) => String(x.d || "").localeCompare(String(y.d || "")));
    if (!hist.length) hist = [{ d: String(a.updated || "").slice(0, 10) || new Date().toISOString().slice(0, 10), v: a.amount, inn: 0, out: 0 }];

    const now = dateToSerial(new Date().toISOString().slice(0, 10));
    for (const h of hist) {
      const dd = String(h.d || "").slice(0, 10);
      if (!dd) continue;
      const sd = dateToSerial(dd);
      rows.push(["记总资产", sd, null, num(h.v), null, now, ""]);
      const inn = Number(h.inn) || 0;
      const out = Number(h.out) || 0;
      if (inn || out) rows.push(["转入转出", sd, inn - out, num(h.v), null, now, ""]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    for (let r = 5; r <= rows.length; r++) {
      const b = ws[XLSX.utils.encode_cell({ r: r - 1, c: 1 })];
      if (b) b.z = "yyyy-mm-dd";
      const f = ws[XLSX.utils.encode_cell({ r: r - 1, c: 5 })];
      if (f) f.z = "yyyy-mm-dd hh:mm:ss";
    }
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(a.name, idx));
  });
  return wb;
}

/** 把「有知有行」xlsx 解析为 simple-app 投资账户数组（未分配 id） */
export function parseYouzhiyouxing(buffer: ArrayBuffer | Buffer): XlsxInvest[] {
  const wb = XLSX.read(buffer as ArrayBuffer, { type: "array", cellDates: false });
  const result: XlsxInvest[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
    const header = rows[0];
    const acct = rows[1];
    if (!Array.isArray(header) || String(header[0] || "") !== "账户名称") continue;
    if (!Array.isArray(acct) || !acct[0]) continue;

    let recStart = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (Array.isArray(r) && String(r[0] || "") === "记录类型") { recStart = i + 1; break; }
    }
    if (recStart < 0) continue;

    const byDate = new Map<string, { v: number | null; inn: number; out: number }>();
    for (let i = recStart; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r) || !r[0]) continue;
      const type = String(r[0]);
      if (type !== "记总资产" && type !== "转入转出") continue;
      const serial = Number(r[1]);
      if (!Number.isFinite(serial) || serial < 10000 || serial > 80000) continue;
      const ds = serialToDate(serial);
      const tot = num(r[3]);
      const t = num(r[2]) || 0;
      const g = byDate.get(ds) || { v: null, inn: 0, out: 0 };
      if (tot != null) g.v = tot;
      if (type === "转入转出") {
        if (t > 0) g.inn += t;
        else g.out += -t;
      }
      byDate.set(ds, g);
    }

    const dates = [...byDate.keys()].sort();
    let cur: number | null = null;
    const hist: XlsxHist[] = [];
    for (const ds of dates) {
      const g = byDate.get(ds)!;
      if (g.v != null) cur = g.v;
      else if (cur != null) cur += (g.inn || 0) - (g.out || 0);
      hist.push({ d: ds, v: cur != null ? cur : 0, inn: g.inn || 0, out: g.out || 0 });
    }
    if (!hist.length) continue;

    const last = hist[hist.length - 1];
    // 有知有行的导出只记录后续转入转出，不会另写一笔「初始投入」。
    // 第一条总资产就是开户本金（若同日有资金流，则先剔除该笔流量再还原本金）。
    const first = hist[0];
    const opening = Math.max(0, (Number(first.v) || 0) - (Number(first.inn) || 0) + (Number(first.out) || 0));
    const inAmt = opening + hist.reduce((s, h) => s + (Number(h.inn) || 0), 0);
    const outAmt = hist.reduce((s, h) => s + (Number(h.out) || 0), 0);
    const code = curCode(String(acct[4] || ""));

    result.push({
      id: "",
      name: String(acct[0]).trim(),
      cur: code,
      amount: Number(last.v) || 0,
      bucket: bucketFromLabel(String(acct[5] || "长期投资")),
      market: marketFromCur(code),
      expected: parsePct(acct[2]),
      inAmt,
      outAmt,
      updated: last.d,
      hist,
    });
  }
  return result;
}

export function xlsxBuffer(invest: XlsxInvest[]): Buffer {
  const wb = buildYouzhiyouxingWorkbook(invest);
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
}
