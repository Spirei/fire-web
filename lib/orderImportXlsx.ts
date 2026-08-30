import { inflateRawSync } from "zlib";

/**
 * 零依赖 .xlsx 读取器（仅用于订单导入，解析可信的券商导出文件）。
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

interface ZipEntry {
  name: string;
  data: Buffer;
}

function parseZip(buffer: Buffer): ZipEntry[] {
  // 定位 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx 文件（未找到 ZIP 结尾）");
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const centralCount = buffer.readUInt16LE(eocd + 10);
  const entries: ZipEntry[] = [];
  let pos = centralOffset;
  for (let n = 0; n < centralCount; n++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    // 本地文件头校验（跳过文件名+extra 字段到数据区）
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(`不支持的压缩方式: ${method}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`条目解压大小不符: ${name}`);
    }
    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
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
  const entries = parseZip(buffer);
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
