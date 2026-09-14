// 有知有行「投资记账」xlsx 导出/导入 兼容工具
// 有知有行导出格式（一个账户一个 sheet）：
//   row1: 账户名称 | 账户目标 | 预期年化收益率 | 预计投资时间 | 币种 | 四笔钱
//   row2: <account 元数据值>
//   row3: 空
//   row4: 记录类型 | 记账时间 | 转入转出金额 | 总资产金额 | 投资日志 | 创建时间 | 明细
//   row5+: 记总资产 / 转入转出 记录
import ExcelJS from "exceljs";

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
  const wb = new ExcelJS.Workbook();
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

    const ws = wb.addWorksheet(sanitizeSheetName(a.name, idx));
    ws.addRows(rows);
    for (let r = 5; r <= rows.length; r++) {
      ws.getCell(r, 2).numFmt = "yyyy-mm-dd";
      ws.getCell(r, 6).numFmt = "yyyy-mm-dd hh:mm:ss";
    }
  });
  return wb;
}

function primitiveCell(value: ExcelJS.CellValue): unknown {
  if (value instanceof Date) return dateToSerial(value.toISOString().slice(0, 10));
  if (!value || typeof value !== "object") return value;
  if ("result" in value) return primitiveCell((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
  if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((item) => item.text).join("");
  if ("text" in value) return String((value as { text?: unknown }).text ?? "");
  return null;
}

function worksheetRows(ws: ExcelJS.Worksheet): unknown[][] {
  const rows: unknown[][] = [];
  for (let number = 1; number <= ws.rowCount; number++) {
    const row = ws.getRow(number);
    const values: unknown[] = [];
    for (let column = 1; column <= Math.min(row.cellCount, 32); column++) values.push(primitiveCell(row.getCell(column).value));
    rows.push(values);
  }
  return rows;
}

/** Reject malformed/encrypted/oversized XLSX archives before workbook decompression. */
export function assertSafeXlsxArchive(input: ArrayBuffer | Buffer) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw new Error("无效的 xlsx 文件");
  const searchStart = Math.max(0, data.length - 65_557);
  let eocd = -1;
  for (let index = data.length - 22; index >= searchStart; index--) {
    if (data.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("无效的 xlsx 文件");
  const entries = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (!entries || entries > 2_000 || directoryOffset + directorySize > data.length) throw new Error("xlsx 文件结构过大");
  let offset = directoryOffset, totalUncompressed = 0;
  for (let count = 0; count < entries; count++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw new Error("无效的 xlsx 文件");
    const flags = data.readUInt16LE(offset + 8);
    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28), extraLength = data.readUInt16LE(offset + 30), commentLength = data.readUInt16LE(offset + 32);
    if ((flags & 1) !== 0 || uncompressed > 20 * 1024 * 1024) throw new Error("xlsx 文件包含不安全内容");
    totalUncompressed += uncompressed;
    if (totalUncompressed > 50 * 1024 * 1024 || (compressed > 0 && uncompressed / compressed > 200)) throw new Error("xlsx 文件解压后过大");
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

/** 把「有知有行」xlsx 解析为 simple-app 投资账户数组（未分配 id） */
export async function parseYouzhiyouxing(buffer: ArrayBuffer | Buffer): Promise<XlsxInvest[]> {
  assertSafeXlsxArchive(buffer);
  const wb = new ExcelJS.Workbook();
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const result: XlsxInvest[] = [];

  if (wb.worksheets.length > 100) throw new Error("工作表过多");
  let totalRows = 0;
  for (const ws of wb.worksheets) {
    totalRows += ws.rowCount;
    if (ws.rowCount > 10_000 || totalRows > 50_000) throw new Error("工作表数据过多");
    const rows = worksheetRows(ws);
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

export async function xlsxBuffer(invest: XlsxInvest[]): Promise<Buffer> {
  const wb = buildYouzhiyouxingWorkbook(invest);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
