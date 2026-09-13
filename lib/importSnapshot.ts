/* ---------- 截图识别结果 → 持仓/自选 记录（规范化 + 素材库匹配 + 应用） ---------- */
import { getAssets, type Asset } from "./assets";
import { randomBytes } from "crypto";
import { getDb } from "./db";
import { listRecords } from "./store";
import type { StockRecord } from "./types";

/** 识别引擎输出的原始行（引擎接入后转换为该结构） */
export interface SnapshotRow {
  name?: string;
  code?: string;
  market?: string;
  qty?: number;
  price?: number;
  cost?: number;
  changePct?: number;
}

const MARKET_ALIASES: Record<string, string> = {
  US: "US", USA: "US", NASDAQ: "US", NYSE: "US", AMEX: "US", OTC: "US",
  HK: "HK", HONGKONG: "HK",
  CN: "CN", A: "CN", SH: "CN", SZ: "CN", BJ: "CN", SSE: "CN", SZSE: "CN",
  SG: "SG", SINGAPORE: "SG", SGX: "SG",
  JP: "JP", JAPAN: "JP", T: "JP", TYO: "JP",
  KR: "KR", KOREA: "KR", KS: "KR", KQ: "KR", KOSPI: "KR",
  UK: "UK", L: "UK", LSE: "UK"
};

export interface ImportRow {
  name: string;
  code: string;
  market: string;
  qty: number | null;
  price: number | null;
  cost: number | null;
  changePct: number | null;
  status: "new" | "update" | "skip";
  matched: boolean;
  matchedName?: string;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value)
    .replace(/[,，¥$HK$€£%]/g, "")
    .replace(/[－—–-]/g, "")
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeMarket(raw: string): string {
  const v = (raw || "").trim().toUpperCase().replace(/[.:_]/g, "");
  return MARKET_ALIASES[v] || (v.length >= 2 && v.length <= 10 ? v : "");
}

/** 代码规范化：去掉市场前后缀（US:、.US、:HK、SH 前缀等），仅保留证券代码 */
function normalizeCode(raw: string, marketHint?: string): string {
  let v = (raw || "").trim().toUpperCase();
  // 形如 US:BABA / BABA.US / HK00700 / SH600519 的带市场写法
  const split = v.match(/^(US|HK|CN|SH|SZ|BJ|SG|JP|KR|UK)[.:]?([A-Z0-9._-]+)$/);
  if (split) {
    v = split[2];
  } else {
    v = v.replace(/\.(US|HK|CN|SG|JP|KR|UK|AM|N|OQ|PS|K)$/i, "");
  }
  if (marketHint === "CN") v = v.replace(/^(SH|SZ|BJ)/, "");
  if (marketHint === "HK") v = v.replace(/^HK/, "");
  return v.replace(/[^A-Z0-9._-]/g, "").slice(0, 40);
}

function codeKey(market: string, code: string): string {
  return `${(market || "?").toUpperCase()}:${code.toUpperCase()}`;
}

/** 素材库股票匹配：优先 market+code，其次按 code 唯一匹配，回填规范市场与名称 */
function buildAssetMaps() {
  const stocks: Asset[] = [];
  try {
    stocks.push(...getAssets("stock"));
  } catch {
    /* 素材库异常不影响导入 */
  }
  const byKey = new Map<string, Asset>();
  const byCode = new Map<string, Asset[]>();
  for (const asset of stocks) {
    const code = normalizeCode(asset.code);
    if (!code) continue;
    byKey.set(codeKey(asset.market, code), asset);
    const list = byCode.get(code) || [];
    list.push(asset);
    byCode.set(code, list);
  }
  return { byKey, byCode };
}

export function buildImportPreview(userId: string, rows: SnapshotRow[]): ImportRow[] {
  const { byKey, byCode } = buildAssetMaps();
  const existing = listRecords(userId);
  return rows.slice(0, 100).map((row) => {
    const marketHint = normalizeMarket(row.market || "");
    const code = normalizeCode(row.code || "", marketHint || undefined);
    const name = (row.name || "").trim().slice(0, 100);
    if (!code && !name) {
      return { name, code, market: marketHint, qty: null, price: null, cost: null, changePct: null, status: "skip", matched: false };
    }

    // 素材库匹配：先 market+code，再 code 唯一
    let asset: Asset | undefined;
    let market = marketHint;
    if (code) {
      asset = byKey.get(codeKey(market, code));
      if (!asset && market && byKey.has(codeKey("", code))) {
        asset = byKey.get(codeKey("", code));
      }
      if (!asset && market) {
        const candidates = byCode.get(code) || [];
        asset = candidates.find((a) => normalizeMarket(a.market) === market) || candidates[0];
      }
      if (!asset) {
        const candidates = byCode.get(code) || [];
        asset = candidates.length === 1 ? candidates[0] : undefined;
      }
      if (asset) market = normalizeMarket(asset.market) || market;
    }

    const record = existing.find((r) => {
      if (r.code.toUpperCase() !== code.toUpperCase()) return false;
      return !market || r.market.toUpperCase() === market;
    }) || (code ? existing.find((r) => r.code.toUpperCase() === code.toUpperCase()) : undefined);

    return {
      name: name || asset?.name || "",
      code,
      market,
      qty: toNumber(row.qty),
      price: toNumber(row.price),
      cost: toNumber(row.cost),
      changePct: toNumber(row.changePct),
      status: record ? "update" : "new",
      matched: !!asset,
      matchedName: asset?.name || record?.name
    };
  });
}

export interface ApplyResult {
  added: number;
  updated: number;
  skipped: number;
  records: StockRecord[];
}

export function applyImport(userId: string, rows: ImportRow[], watchGroupId?: string): ApplyResult {
  const existing = listRecords(userId);
  const db = getDb();
  const byMarketCode = new Map(existing.map((record) => [codeKey(record.market, record.code), record]));
  const byCode = new Map<string, StockRecord>();
  for (const record of existing) {
    const key = record.code.toUpperCase();
    if (!byCode.has(key)) byCode.set(key, record);
  }
  const insert = db.prepare(`
    INSERT INTO records (id, user_id, name, code, market, price, cost, qty, group_name, watch_group_id, note, source, updated_at)
    VALUES (@id, @userId, @name, @code, @market, @price, @cost, @qty, @group, @watchGroupId, @note, 'snapshot', @updatedAt)
  `);
  const update = db.prepare(`
    UPDATE records
    SET name = @name, code = @code, market = @market, price = @price, cost = @cost, qty = @qty,
        group_name = @group, watch_group_id = @watchGroupId, note = @note, source = 'snapshot', updated_at = @updatedAt
    WHERE id = @id AND user_id = @userId
  `);
  let added = 0;
  let updated = 0;
  let skipped = 0;

  const applyRows = db.transaction(() => rows.slice(0, 2000).forEach((row) => {
    const code = normalizeCode(row.code);
    const name = (row.name || "").trim().slice(0, 100);
    const market = normalizeMarket(row.market);
    if (!code || !name) {
      skipped += 1;
      return;
    }
    const price = row.price === null || row.price === undefined || row.price < 0 ? "" : row.price;
    const cost = row.cost === null || row.cost === undefined ? "" : row.cost;
    const qty = row.qty === null || row.qty === undefined ? "" : row.qty;

    const record = (market ? byMarketCode.get(codeKey(market, code)) : undefined) || byCode.get(code.toUpperCase());
    const resolvedMarket = market || record?.market || "OTHER";
    const updatedAt = new Date().toISOString();

    if (record) {
      update.run({
        id: record.id, userId, name, code, market: resolvedMarket,
        price: row.price !== null && row.price !== undefined ? price : record.price,
        cost: row.cost !== null && row.cost !== undefined ? cost : (record.cost === "" ? null : record.cost),
        qty: row.qty !== null && row.qty !== undefined ? qty : (record.qty === "" ? null : record.qty),
        group: record.group, watchGroupId: watchGroupId || record.watchGroupId || "", note: record.note, updatedAt
      });
      updated += 1;
    } else {
      const id = "r-" + randomBytes(8).toString("hex");
      insert.run({ id, userId, name, code, market: resolvedMarket, price, cost: cost === "" ? null : cost, qty: qty === "" ? null : qty, group: "", watchGroupId: watchGroupId || "", note: "", updatedAt });
      const created: StockRecord = { id, name, code, market: resolvedMarket as StockRecord["market"], price: price === "" ? 0 : price, cost, qty, group: "", watchGroupId: watchGroupId || "", watchGroupSort: 0, note: "", source: "snapshot", updatedAt };
      byMarketCode.set(codeKey(resolvedMarket, code), created);
      byCode.set(code.toUpperCase(), created);
      added += 1;
    }
  }));
  applyRows();

  return { added, updated, skipped, records: listRecords(userId) };
}
