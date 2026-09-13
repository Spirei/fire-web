import { importIdentity, normalizeImportMarket } from "./importIdentity";
export interface FileImportRow { code: string; name: string; market: string }

// CSV/TSV reader preserves empty cells, escaped quotes and quoted newlines.
function readDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === delimiter || char === '\n')) {
      row.push(field.trim()); field = "";
      if (char === '\n') { rows.push(row); row = []; }
    } else if (char !== '\r' || quoted) field += char;
  }
  if (quoted) throw new Error("CSV 引号未闭合，请检查文件内容");
  if (field || row.length) rows.push([...row, field.trim()]);
  return rows;
}
function normalizeRow(codeValue: unknown, nameValue: unknown, marketValue: unknown): FileImportRow {
  const raw = String(codeValue ?? "");
  const identity = importIdentity(raw, String(marketValue ?? ""));
  if (!identity.code) throw new Error(`股票代码无效：${raw.slice(0, 40)}`);
  let { market } = identity;
  if (!market) market = /^\d{5}$/.test(identity.code) ? "HK" : /^\d{6}$/.test(identity.code) ? "CN" : /^[A-Z]/.test(identity.code) ? "US" : "";
  if (!market) throw new Error(`请为 ${identity.code} 指定市场，例如 JP 或 HK`);
  return { ...importIdentity(identity.code, market), name: String(nameValue || identity.code).trim() };
}
export function parseStockFile(text: string): FileImportRow[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  if (trimmed.includes('\0')) throw new Error("不支持二进制自选文件，请先导出为 TXT、CSV 或 JSON");
  let rows: FileImportRow[];
  if (/^[\[{]/.test(trimmed)) {
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : parsed?.rows;
    if (!Array.isArray(items)) throw new Error("JSON 必须是股票数组或包含 rows 数组");
    rows = items.map(item => normalizeRow(item.code ?? item.symbol, item.name ?? item.title, item.market));
  } else {
    const first = trimmed.split(/\r?\n/)[0];
    const cells = first.includes('\t') ? readDelimited(trimmed, '\t') : first.includes(',') ? readDelimited(trimmed, ',') : trimmed.split(/\r?\n/).map(line => {
      const parts = line.trim().split(/\s+/);
      const market = parts.length > 1 && normalizeImportMarket(parts[parts.length - 1]) ? parts.pop() : "";
      return [parts.shift() || "", parts.join(" "), market || ""];
    });
    rows = cells.filter(row => row.some(Boolean) && !/^(代码|code|symbol)$/i.test(row[0])).map(row => normalizeRow(row[0], row[1], row[2]));
  }
  if (rows.length > 2000) throw new Error(`文件包含 ${rows.length} 只股票，单次最多 2000 只，请拆分后导入`);
  return rows;
}
