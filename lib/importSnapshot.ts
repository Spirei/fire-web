/* ---------- 截图识别结果 → 持仓/自选 记录（规范化 + 素材库匹配 + 应用） ---------- */
import { getAssets, type Asset } from "./assets";
import { randomBytes } from "crypto";
import { getDb } from "./db";
import { listRecords } from "./store";
import { importIdentity, importCodeKey as codeKey, normalizeImportMarket as normalizeMarket } from "./importIdentity";
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
    .replace(/[－—–−]/g, "-")
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeCode(raw: string, marketHint?: string): string {
  return importIdentity(raw, marketHint).code;
}

function recordIndex(records: StockRecord[]) {
  const byKey = new Map<string, StockRecord[]>();
  const byCode = new Map<string, StockRecord[]>();
  function add(record: StockRecord) {
    const { market, code } = importIdentity(record.code, record.market);
    const key = `${market}:${code}`;
    byKey.set(key, [...(byKey.get(key) || []), record]);
    byCode.set(code, [...(byCode.get(code) || []), record]);
  }
  records.forEach(add);
  return { add, find(market: string, code: string) {
    const matches = (market ? byKey.get(codeKey(market, code)) : byCode.get(code)) || [];
    if (matches.length > 1) throw new Error(`股票 ${code} 匹配到多条记录，请指定市场并处理重复持仓`);
    return matches[0];
  } };
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
  const index = recordIndex(existing);
  return rows.slice(0, 100).map((row) => {
    const { market: marketHint, code } = importIdentity(row.code || "", row.market || "");
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
      if (!asset && !market) {
        const candidates = byCode.get(code) || [];
        asset = candidates.length === 1 ? candidates[0] : undefined;
      }
      if (asset) market = normalizeMarket(asset.market) || market;
    }

    const record = index.find(market, code);

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
  const index = recordIndex(existing);
  const db = getDb();
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
    const { code, market } = importIdentity(row.code, row.market);
    let name = (row.name || code).trim().slice(0, 100);
    if (!code || !name) {
      skipped += 1;
      return;
    }
    const price = row.price === null || row.price === undefined || row.price < 0 ? "" : row.price;
    const cost = row.cost === null || row.cost === undefined ? "" : row.cost;
    const qty = row.qty === null || row.qty === undefined ? "" : row.qty;

    const record = index.find(market, code);
    if (!market && !record) throw new Error(`请为 ${code} 指定市场`);
    const resolvedMarket = market || record?.market || "OTHER";
    const updatedAt = new Date().toISOString();

    if (row.qty != null && (!Number.isFinite(row.qty) || row.qty < 0)) throw new Error(`导入 ${code} 的数量不能为负数`);
    if (row.price != null && (!Number.isFinite(row.price) || row.price < 0)) throw new Error(`导入 ${code} 的现价不能为负数`);
    if (record) {
      if (name === code) name = record.name;
      update.run({
        id: record.id, userId, name, code, market: resolvedMarket,
        price: row.price !== null && row.price !== undefined ? price : record.price,
        cost: row.cost !== null && row.cost !== undefined ? cost : (record.cost === "" ? null : record.cost),
        qty: row.qty !== null && row.qty !== undefined ? qty : (record.qty === "" ? null : record.qty),
        group: record.group, watchGroupId: watchGroupId || record.watchGroupId || "", note: record.note, updatedAt
      });
      Object.assign(record, { name, code, market: resolvedMarket, updatedAt,
        ...(row.price != null ? { price } : {}), ...(row.cost != null ? { cost } : {}), ...(row.qty != null ? { qty } : {}),
        watchGroupId: watchGroupId || record.watchGroupId || "" });
      updated += 1;
    } else {
      const id = "r-" + randomBytes(8).toString("hex");
      insert.run({ id, userId, name, code, market: resolvedMarket, price, cost: cost === "" ? null : cost, qty: qty === "" ? null : qty, group: "", watchGroupId: watchGroupId || "", note: "", updatedAt });
      const created: StockRecord = { id, name, code, market: resolvedMarket as StockRecord["market"], price: price === "" ? 0 : price, cost, qty, group: "", watchGroupId: watchGroupId || "", watchGroupSort: 0, note: "", source: "snapshot", updatedAt };
      index.add(created);
      added += 1;
    }
  }));
  applyRows();

  return { added, updated, skipped, records: listRecords(userId) };
}
