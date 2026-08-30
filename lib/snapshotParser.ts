/* Apple Vision 识别文本 → 结构化持仓/自选行（启发式，预览可编辑，够用即可） */
import type { SnapshotRow } from "./importSnapshot";

export interface VisionLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const CJK = /[\u3400-\u9fff]/;
const CODE_STOPWORDS = new Set([
  "ETF", "ETFS", "USD", "HKD", "CNY", "RMB", "US", "HK", "CN", "INC", "LTD",
  "CORP", "CO", "LTD", "PLC"
]);
const NAME_STOPWORDS = new Set([
  "NASDAQ", "NYSE", "AMEX", "OTC", "SPX", "INDEX", "NASDAQ100", "SSE", "SZSE",
  "BSE", "HONG", "KONG", "CHINA", "UNITED", "STATES", "STOCK", "MARKET", "A股",
  "美股", "港股", "US", "HK", "CN", "JP", "KR", "SG", "UK", "A", "SH", "SZ", "BJ"
]);

type TokenKind = "percent" | "money" | "qty" | "number" | "code" | "name" | "other";

function classify(text: string): TokenKind {
  const t = text.trim();
  if (!t) return "other";
  // 涨跌幅：±12.34%
  if (/^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?%$/.test(t) || /^[+-]?\d+(?:\.\d+)?%$/.test(t)) {
    return "percent";
  }
  // 市值等大数：2915亿 / 1.23万亿 / 2345.67万
  if (/[万亿]/.test(t) && /\d/.test(t)) return "money";
  // 带单位的数量：100股 / 1,000份
  const withUnit = t.match(/^([+-]?[\d,]+(?:\.\d+)?)(股|份|张|手|万元|亿美元)?$/);
  if (withUnit && withUnit[2]) return "qty";
  // 带市场后缀的代码：0700.HK / BABA.US / 600519.SH
  if (/^[A-Z0-9.]+\.(US|HK|JP|KS|KQ|L|SG|SH|SZ|BJ)$/i.test(t)) return "code";
  // 纯大写字母或字母数字混合代码：AAPL / TSLL / SH600519 / 00700
  if (/^[A-Z]{2,5}$/.test(t) && !CODE_STOPWORDS.has(t)) return "code";
  if (/^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{2,12}$/.test(t)) return "code";
  if (/^\d{4,6}$/.test(t)) return "code";
  if (/^[+-]?[\d,]+(?:\.\d+)?$/.test(t)) return "number";
  // 中文或英文名称
  if (CJK.test(t)) return "name";
  if (/^[A-Za-z][A-Za-z .&'-]*$/.test(t) && !NAME_STOPWORDS.has(t.toUpperCase())) return "name";
  return "other";
}

function marketFromCode(code: string): string {
  const c = code.toUpperCase();
  if (/\.(US|SH|SZ|BJ)$/.test(c)) return /\.SH$|\.SZ$|\.BJ$/.test(c) ? "CN" : "US";
  if (/\.HK$/.test(c)) return "HK";
  if (/\.JP$/.test(c)) return "JP";
  if (/\.(KS|KQ)$/.test(c)) return "KR";
  if (/\.SG$/.test(c)) return "SG";
  if (/\.L$/.test(c)) return "UK";
  if (/^(SH|SZ|BJ)\d{6}$/.test(c)) return "CN";
  if (/^\d{6}$/.test(c)) return "CN";
  if (/^\d{4,5}$/.test(c)) return "HK";
  if (/^[A-Z]{2,5}$/.test(c)) return "US";
  return "";
}

function cleanName(tokens: string[]): string {
  const parts: string[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const upper = t.toUpperCase();
    if (NAME_STOPWORDS.has(upper)) continue;
    parts.push(t);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function toNum(t: string): number | null {
  const cleaned = t
    .replace(/[,，¥$HK$€£%]/g, "")
    .replace(/[－—–]/g, "-")
    .replace(/(美元|港元|元|股|份|张|手)$/g, "")
    .trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toPct(t: string): number | null {
  const cleaned = t.replace(/[,，%]/g, "").replace(/[－—–]/g, "-").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isDecimal(t: string): boolean {
  return /\.\d+/.test(t);
}

interface RowToken {
  text: string;
  x: number;
}

/** 按视觉行聚类：y 中心接近的文本归为一行，行内按 x 排序 */
function clusterLines(lines: VisionLine[]): RowToken[][] {
  const positioned = lines
    .map((l) => ({
      text: l.text,
      x: l.x,
      top: 1 - (l.y + l.h),
      cy: 1 - (l.y + l.h / 2)
    }))
    .sort((a, b) => a.top - b.top);

  interface PendingRow {
    cy: number;
    tokens: RowToken[];
  }
  const rows: PendingRow[] = [];
  for (const p of positioned) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(p.cy - last.cy) < 0.015) {
      last.tokens.push({ text: p.text, x: p.x });
    } else {
      rows.push({ cy: p.cy, tokens: [{ text: p.text, x: p.x }] });
    }
  }
  for (const row of rows) row.tokens.sort((a, b) => a.x - b.x);
  return rows.map((r) => r.tokens);
}

function parseRow(tokens: RowToken[]): SnapshotRow | null {
  const texts = tokens.map((t) => t.text);
  const joined = texts.join(" ").trim();
  if (!/[A-Z0-9\u3400-\u9fff]/.test(joined)) return null;

  const kinds = texts.map((t) => classify(t));
  const codeTokens = tokens.filter((_, i) => kinds[i] === "code");
  const hasCode = codeTokens.length > 0;

  // 表头行（代码/名称/最新价…）没有代码，跳过
  if (!hasCode && /^(代码|名称|最新价|现价|涨跌幅|市值|持仓|成本|盈亏|序号|操作|数量|金额|方向)/.test(joined)) {
    return null;
  }
  const nameTokens = tokens.filter((_, i) => kinds[i] === "name");
  if (!hasCode && nameTokens.length === 0) return null;

  // 代码：优先取含市场后缀的，其次第一个代码
  let code = "";
  let market = "";
  if (codeTokens.length > 0) {
    const suffixed = codeTokens.find((t) => /\.(US|HK|JP|KS|KQ|L|SG|SH|SZ|BJ)$/i.test(t.text));
    const chosen = suffixed || codeTokens[0];
    code = chosen.text.trim().toUpperCase();
    market = marketFromCode(code);
  }

  const name = cleanName(nameTokens.map((t) => t.text));
  if (!hasCode && name && !/^[\u3400-\u9fff·]{2,8}$/.test(name)) return null;
  if (
    !hasCode &&
    name &&
    /^(自选股|我的持仓|持仓|行情|全部|关注|自选|总资产|账户|资产|交易|订单|更多|编辑|完成|搜索|刷新|今日|热门|首页|市场|板块|暂无数据|加载中|正在加载|更新时间)$/.test(
      name
    )
  ) {
    return null;
  }

  // 数字归类：优先跟随中文标签（成本/现价/数量），否则按出现顺序回退
  let qty: number | null = null;
  let price: number | null = null;
  let cost: number | null = null;
  let changePct: number | null = null;

  const labelIdx: Record<string, number> = {};
  ["成本", "现价", "最新价", "数量", "持仓", "市值"].forEach((label) => {
    const idx = texts.findIndex((t) => t.includes(label));
    if (idx >= 0) labelIdx[label] = idx;
  });

  for (let i = 0; i < tokens.length; i += 1) {
    const kind = kinds[i];
    const t = texts[i];
    if (kind === "percent") {
      if (changePct === null) changePct = toPct(t);
      continue;
    }
    if (kind === "money") continue;
    if (kind === "qty") {
      if (qty === null) qty = toNum(t);
      continue;
    }
    if (kind !== "number") continue;
    const value = toNum(t);
    if (value === null) continue;

    // 标签提示优先
    if (labelIdx["成本"] !== undefined && i > labelIdx["成本"] && cost === null) {
      cost = value;
      continue;
    }
    if ((labelIdx["现价"] !== undefined && i > labelIdx["现价"]) || (labelIdx["最新价"] !== undefined && i > labelIdx["最新价"])) {
      if (price === null) {
        price = value;
        continue;
      }
    }
    if ((labelIdx["数量"] !== undefined && i > labelIdx["数量"]) || (labelIdx["持仓"] !== undefined && i > labelIdx["持仓"])) {
      if (qty === null && !isDecimal(t)) {
        qty = value;
        continue;
      }
    }
    // 回退：整数先当数量，小数按顺序当现价/成本
    if (!isDecimal(t)) {
      if (qty === null) {
        qty = value;
        continue;
      }
      if (price === null) {
        price = value;
        continue;
      }
    } else {
      // 持仓布局（行内有数量）：小数按 [成本, 现价]；行情布局：按 [现价]
      if (qty !== null) {
        if (cost === null) {
          cost = value;
          continue;
        }
        if (price === null) {
          price = value;
          continue;
        }
      } else {
        if (price === null) {
          price = value;
          continue;
        }
        if (cost === null) {
          cost = value;
          continue;
        }
      }
    }
  }

  if (!code && !name) return null;
  const num = (v: number | null): number | undefined => (v === null ? undefined : v);
  return {
    name: name || undefined,
    code: code || undefined,
    market: market || undefined,
    qty: num(qty),
    price: num(price),
    cost: num(cost),
    changePct: num(changePct)
  };
}

/** 识别行 → 结构化快照行（去重：同市场同代码保留第一条） */
export function parseSnapshot(lines: VisionLine[]): SnapshotRow[] {
  const rows = clusterLines(lines);
  const seen = new Set<string>();
  const out: SnapshotRow[] = [];
  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed || (!parsed.code && !parsed.name)) continue;
    if (parsed.code) {
      const key = `${parsed.market || "?"}:${parsed.code.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(parsed);
  }
  return out.slice(0, 100);
}

/** 识别原文（阅读顺序），用于前端「识别原文」折叠区 */
export function rawText(lines: VisionLine[]): string {
  return clusterLines(lines)
    .map((row) => row.map((t) => t.text).join(" "))
    .join("\n");
}
