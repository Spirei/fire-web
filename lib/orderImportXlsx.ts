import { inflateRawSync } from "zlib";

/**
 * 零依赖 .xlsx 读取器（订单导入的上传文件始终视为不可信输入）。
 * 与 lib/xlsx.ts（写入器）对称：ZIP 中央目录解析 + OOXML inlineStr 单元格提取。
 * 不做任意 XML 解析，只提取导入所需的 <row>/<c>/<is>/<t> 结构。
 */

/** 解析出的券商订单行：字段名来自表头（订单状态/市场/股票代码/…） */
export type BrokerOrderRow = Record<string, string>;

export interface BrokerOrderSheet {
  /** 表头行（第一个字段为 订单状态 时视为有效数据表） */
  headers: string[];
  rows: BrokerOrderRow[];
}

// ---------- ZIP 读取 ----------

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Validate and inflate every entry with hard output limits before any workbook parser runs. */
export function readSafeXlsxEntries(buffer: Buffer): ZipEntry[] {
  const MAX_ENTRIES = 2_000, MAX_ENTRY_BYTES = 20 * 1024 * 1024, MAX_TOTAL_BYTES = 50 * 1024 * 1024;
  if (buffer.length < 22) throw new Error("不是有效的 xlsx 文件");
  // 定位 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx 文件（未找到 ZIP 结尾）");
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const centralCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12), centralEnd = centralOffset + centralSize;
  if (!centralCount || centralCount > MAX_ENTRIES || centralEnd !== eocd
    || buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6)
    || buffer.readUInt16LE(eocd + 8) !== centralCount
    || eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) throw new Error("xlsx 文件结构无效或过大");
  const checkExtra = (start: number, length: number) => {
    const end = start + length;
    for (let offset = start; offset < end;) {
      if (offset + 4 > end) throw new Error("xlsx 额外字段无效");
      const id = buffer.readUInt16LE(offset), bytes = buffer.readUInt16LE(offset + 2);
      if (id === 0x0001 || id === 0x9901 || offset + 4 + bytes > end) throw new Error("不支持 ZIP64 或加密 xlsx 文件");
      offset += 4 + bytes;
    }
  };
  const entries: ZipEntry[] = [];
  let pos = centralOffset, total = 0;
  for (let n = 0; n < centralCount; n++) {
    if (pos + 46 > centralEnd || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error("xlsx 中央目录无效");
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > centralEnd || (flags & 0x41) || buffer.readUInt16LE(pos + 34)
      || uncompressedSize > MAX_ENTRY_BYTES
      || total + uncompressedSize > MAX_TOTAL_BYTES || (compressedSize > 0 && uncompressedSize / compressedSize > 200)) throw new Error("xlsx 文件解压后过大或包含不安全内容");
    checkExtra(pos + 46 + nameLen, extraLen);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    // 本地文件头校验（跳过文件名+extra 字段到数据区）
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50
      || buffer.readUInt16LE(localOffset + 8) !== method || buffer.readUInt16LE(localOffset + 6) !== flags) throw new Error("xlsx 本地文件头无效");
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > centralOffset) throw new Error("xlsx 条目数据越界");
    checkExtra(localOffset + 30 + localNameLen, localExtraLen);
    if (!buffer.subarray(localOffset + 30, localOffset + 30 + localNameLen).equals(buffer.subarray(pos + 46, pos + 46 + nameLen))) throw new Error("xlsx 文件名不一致");
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      // Enforce the actual output limit too: ZIP size metadata can be forged.
      data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(uncompressedSize, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - total)) });
    } else {
      throw new Error(`不支持的压缩方式: ${method}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`条目解压大小不符: ${name}`);
    }
    entries.push({ name, data });
    total += data.length;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== centralEnd) throw new Error("xlsx 中央目录长度不符");
  if (entries.length === 0) throw new Error("xlsx 内没有条目");
  return entries;
}

// ---------- 简易 XML 提取 ----------

function escapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 提取 sheet 的全部行：每行返回 { ref, cells }，cells 按列字母 → 文本 */
function parseSheetXml(xml: string): Array<{ cells: Record<string, string> }> {
  const rows: Array<{ cells: Record<string, string> }> = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(xml)) !== null) {
    if (rows.length >= 20_001) throw new Error("单次最多导入 20000 条订单，请拆分文件");
    const rowBody = match[1];
    const cells: Record<string, string> = {};
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowBody)) !== null) {
      const attrs = cm[1];
      const body = cm[2] ?? "";
      const refMatch = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!refMatch) continue;
      const col = refMatch[1];
      // inlineStr: <is><t>…</t></is>；numeric: <v>…</v>
      let value = "";
      const t = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? "";
      if (t === "inlineStr") {
        const textMatch = /<is>([\s\S]*?)<\/is>/.exec(body);
        if (textMatch) {
          const inner = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(textMatch[1]);
          value = inner ? escapeXml(inner[1]) : "";
        }
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vMatch ? vMatch[1] : "";
      }
      cells[col] = value;
    }
    rows.push({ cells });
  }
  return rows;
}

/** 从 workbook.xml 提取 sheet 名 → 关系 id 顺序 */
function sheetRids(xml: string): string[] {
  const rids: string[] = [];
  const re = /<sheet\b[^>]*\br:id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) rids.push(match[1]);
  return rids;
}

function relTargets(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) map[match[1]] = match[2];
  return map;
}

// ---------- 对外 API ----------

const HEADER_ANCHOR = "订单状态";

/** 读取 xlsx：找到 A1=订单状态 的数据表，返回 表头 + 全部行（行内按列字母取值） */
export function readBrokerOrderSheet(buffer: Buffer): BrokerOrderSheet {
  const entries = readSafeXlsxEntries(buffer);
  const byPath = new Map(entries.map((e) => [e.name.replace(/^\//, ""), e.data]));
  const workbook = byPath.get("xl/workbook.xml");
  if (!workbook) throw new Error("xlsx 缺少 xl/workbook.xml");
  const rels = byPath.get("xl/_rels/workbook.xml.rels");
  const targets = rels ? relTargets(rels.toString("utf8")) : {};
  const rids = sheetRids(workbook.toString("utf8"));

  const cols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const rid of rids) {
    const target = targets[rid];
    if (!target) continue;
    const path = `xl/${target.replace(/^\/+/, "")}`;
    const data = byPath.get(path);
    if (!data) continue;
    const rows = parseSheetXml(data.toString("utf8"));
    if (rows.length === 0) continue;
    const first = rows[0].cells["A"] ?? "";
    if (first !== HEADER_ANCHOR) continue;
    // 表头：A 起顺序取列字母，直到连续空两列
    const headers: string[] = [];
    for (let i = 0; i < cols.length; i++) {
      const value = (rows[0].cells[cols[i]] ?? "").trim();
      headers.push(value);
    }
    const dataRows: BrokerOrderRow[] = rows.slice(1).map((row) => {
      const out: BrokerOrderRow = {};
      headers.forEach((header, index) => {
        const col = cols[index];
        if (header) out[header] = row.cells[col] ?? "";
      });
      return out;
    });
    return { headers, rows: dataRows };
  }
  throw new Error("xlsx 中未找到订单数据表（A1 应为「订单状态」）");
}
