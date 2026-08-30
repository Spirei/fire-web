import { getDb } from "@/lib/db";
import { CURRENT_VERSION } from "@/lib/versions";
import { randomBytes } from "node:crypto";
import { generateOrderNo } from "@/lib/orderNo";

/**
 * 网站设置/数据 导出导入（无损迁移用）
 * 覆盖：全部站点设置、个人偏好、持仓记录、成交订单、操作日志、自选股分组、名人持仓
 *      与当前用户昵称——纯数据；图标/图片为应用默认，上线自带，不打包。
 * 导入时按“upsert（不存在则插入、存在则更新）”在单事务内还原，并将所有 userId
 *      重映射为当前导入用户，做到不覆盖不丢失。
 */
const FORMAT = "fire-site-backup";
const SCHEMA_VERSION = 1;
// 环境专属、不应随站点迁移的设置键（数据库连接串等；线上由部署方在目标环境配置）
const ENV_SETTING_KEYS = new Set(["dbType", "pgHost", "pgPort", "pgDatabase", "pgUser", "pgPassword"]);
const SITE_SETTING_KEYS = new Set([
  "allowRegister", "assetMarketOrder", "chartApiUrl", "cnEarningsApiUrl", "cnLogoApiUrl", "currencyApiUrl", "domain", "earningsApiUrl",
  "footerDesc", "futuHost", "futuPort", "groups", "heroBadge", "heroCtaPrimary", "heroCtaSecondary", "heroSubtitle", "heroTitle",
  "holdingColumns", "homeNav", "homepageBg", "ico", "indicesOrder", "loginSideImage", "logoFont", "logoText", "marketLabels", "markets",
  "quoteApiUrl", "quoteSource", "searchApiUrl", "siteLogo", "stockIconCdn", "tabs", "ticker", "title", "usLogoApiUrl"
]);
const MAX_ROWS = { records: 5000, tradeOrders: 20000, activities: 50000, watchGroups: 500, fundTransactions: 20000, userSettings: 1, celebs: 500 } as const;
const MAX_SITE_SETTINGS = 500;
const MAX_TOTAL_ROWS = 75000;
const COLUMNS = {
  records: ["id", "user_id", "name", "code", "market", "price", "cost", "qty", "group_name", "note", "updated_at", "source", "watch_group_id"],
  trade_orders: ["id", "user_id", "record_id", "market", "code", "name", "side", "status", "qty", "price", "fees", "amount", "realized_pnl", "position_qty_after", "position_cost_after", "broker", "note", "traded_at", "created_at", "position_qty_before", "position_cost_before", "order_no", "order_type", "trigger_price", "tif", "expires_at", "session", "trigger_status"],
  activities: ["id", "user_id", "action", "stock_name", "stock_code", "created_at", "market", "price", "cost", "qty"],
  watch_groups: ["id", "user_id", "name", "icon", "sort", "visible", "kind", "market", "created_at"],
  fund_transactions: ["id", "user_id", "currency", "type", "amount", "direction", "note", "occurred_at", "created_at"],
  user_settings: ["user_id", "fire"],
  celebs: ["id", "name", "title", "avatar", "enabled", "sort", "source_kind", "cik", "entity", "source_label", "holdings_json", "trades_json", "returns_json", "created_at", "updated_at", "stock_icons_json", "refresh_hours"]
} as const;

type ImportKey = keyof typeof MAX_ROWS;
type TableName = keyof typeof COLUMNS;

function newId(prefix: string) { return `${prefix}-${randomBytes(12).toString("hex")}`; }
function text(value: unknown, field: string, max: number, required = false): string {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${field} 缺失`);
    return "";
  }
  const out = String(value);
  if (required && !out.trim()) throw new Error(`${field} 不能为空`);
  if (out.length > max) throw new Error(`${field} 超过 ${max} 字符`);
  return out;
}
function numberValue(value: unknown, field: string, nullable = true): number | null {
  if (value === null || value === undefined || value === "") return nullable ? null : 0;
  const out = Number(value);
  if (!Number.isFinite(out) || Math.abs(out) > 1e15) throw new Error(`${field} 数值无效`);
  return out;
}
function enumValue(value: unknown, field: string, allowed: readonly string[], fallback: string): string {
  const out = String(value ?? fallback);
  if (!allowed.includes(out)) throw new Error(`${field} 值无效`);
  return out;
}
function jsonText(value: unknown, field: string, max: number): string {
  const out = text(value ?? "{}", field, max);
  try { JSON.parse(out); } catch { throw new Error(`${field} 不是有效 JSON`); }
  return out;
}
function assertKnownColumns(row: Record<string, unknown>, table: TableName) {
  const allowed = new Set<string>(COLUMNS[table]);
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${table} 包含不允许字段：${unknown.slice(0, 3).join("、")}`);
}

export function buildBackupPayload(userId: string, isAdmin: boolean) {
  const db = getDb();
  const settingsRows = db.prepare("SELECT key,value FROM site_settings").all() as { key: string; value: string }[];
  const siteSettings: Record<string, string> = {};
  for (const r of settingsRows) {
    if (SITE_SETTING_KEYS.has(r.key) && !ENV_SETTING_KEYS.has(r.key)) siteSettings[r.key] = r.value;
  }
  const userRow = db.prepare("SELECT nickname FROM users WHERE id = ?").get(userId) as { nickname: string | null } | undefined;
  const profile = { nickname: userRow?.nickname ?? "" };

  const data: {
    siteSettings: Record<string, string>;
    userSettings: unknown[];
    records: unknown[];
    tradeOrders: unknown[];
    activities: unknown[];
    watchGroups: unknown[];
    fundTransactions: unknown[];
    celebs: unknown[];
    profile: { nickname: string };
  } = {
    siteSettings: isAdmin ? siteSettings : {},
    userSettings: db.prepare(`SELECT ${COLUMNS.user_settings.join(",")} FROM user_settings WHERE user_id = ?`).all(userId),
    records: db.prepare(`SELECT ${COLUMNS.records.join(",")} FROM records WHERE user_id = ?`).all(userId),
    // 历史库可能残留指向已删除持仓的孤立订单；没有父记录时无法安全恢复，因此不进入可迁移备份。
    tradeOrders: db.prepare(`SELECT ${COLUMNS.trade_orders.map((column) => `o.${column}`).join(",")} FROM trade_orders o WHERE o.user_id = ? AND EXISTS (SELECT 1 FROM records r WHERE r.id = o.record_id AND r.user_id = o.user_id)`).all(userId),
    activities: db.prepare(`SELECT ${COLUMNS.activities.join(",")} FROM activities WHERE user_id = ?`).all(userId),
    watchGroups: db.prepare(`SELECT ${COLUMNS.watch_groups.join(",")} FROM watch_groups WHERE user_id = ?`).all(userId),
    fundTransactions: db.prepare(`SELECT ${COLUMNS.fund_transactions.join(",")} FROM fund_transactions WHERE user_id = ?`).all(userId),
    celebs: isAdmin ? db.prepare(`SELECT ${COLUMNS.celebs.join(",")} FROM celebs`).all() : [],
    profile
  };

  const exportedAt = new Date().toISOString();

  return {
    format: FORMAT,
    version: SCHEMA_VERSION,
    appVersion: CURRENT_VERSION.version,
    exportedAt,
    manifest: {
      app: "Fire",
      appVersion: CURRENT_VERSION.version,
      exportedAt,
      excluded: "图标/图片与素材库为应用默认、上线自带；数据库连接串等环境专属配置不随备份迁移",
      counts: {
        siteSettings: isAdmin ? Object.keys(siteSettings).length : 0,
        userSettings: data.userSettings.length,
        records: data.records.length,
        tradeOrders: data.tradeOrders.length,
        activities: data.activities.length,
        watchGroups: data.watchGroups.length,
        fundTransactions: data.fundTransactions.length,
        celebs: isAdmin ? data.celebs.length : 0,
        profile: profile.nickname ? 1 : 0
      }
    },
    data
  };
}

/** 只做校验+条数统计，不做任何写入（供导入前试算/预览） */
export function validateBackupPayload(payload: unknown) {
  const p = payload as { format?: string; version?: number; data?: Record<string, unknown> };
  if (!p || p.format !== FORMAT) throw new Error("不是有效的 Fire 备份文件");
  if (!Number.isInteger(p.version) || p.version! < 1 || p.version! > SCHEMA_VERSION) throw new Error("备份版本无效或不受支持");
  const d = p.data ?? {};
  const arr = (key: string): Record<string, unknown>[] => {
    const v = d[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`备份中「${key}」格式错误`);
    if (v.length > MAX_ROWS[key as ImportKey]) throw new Error(`备份中「${key}」超过 ${MAX_ROWS[key as ImportKey]} 条限制`);
    return v as Record<string, unknown>[];
  };
  const pkCheck = (key: string) => {
    for (const row of arr(key)) {
      if (!row || typeof row !== "object" || !("id" in row)) throw new Error(`备份中「${key}」缺少 id`);
    }
  };
  pkCheck("records");
  pkCheck("tradeOrders");
  pkCheck("activities");
  pkCheck("watchGroups");
  pkCheck("fundTransactions");
  for (const row of arr("records")) assertKnownColumns(row, "records");
  for (const row of arr("tradeOrders")) assertKnownColumns(row, "trade_orders");
  for (const row of arr("activities")) assertKnownColumns(row, "activities");
  for (const row of arr("watchGroups")) assertKnownColumns(row, "watch_groups");
  for (const row of arr("fundTransactions")) assertKnownColumns(row, "fund_transactions");
  for (const row of arr("userSettings")) assertKnownColumns(row, "user_settings");
  for (const row of arr("celebs")) assertKnownColumns(row, "celebs");
  const ss = d.siteSettings;
  if (ss !== undefined && (typeof ss !== "object" || ss === null || Array.isArray(ss))) throw new Error("备份中「siteSettings」格式错误");
  if (d.profile !== undefined && (typeof d.profile !== "object" || d.profile === null || Array.isArray(d.profile))) throw new Error("备份中「profile」格式错误");
  if (ss && Object.keys(ss as object).length > MAX_SITE_SETTINGS) throw new Error(`站点设置超过 ${MAX_SITE_SETTINGS} 项限制`);
  const totalRows = (Object.keys(MAX_ROWS) as ImportKey[]).reduce((sum, key) => sum + arr(key).length, 0);
  if (totalRows > MAX_TOTAL_ROWS) throw new Error(`备份总行数超过 ${MAX_TOTAL_ROWS} 条限制`);
  return {
    counts: {
      siteSettings: Object.keys((ss ?? {}) as Record<string, unknown>).length,
      records: arr("records").length,
      tradeOrders: arr("tradeOrders").length,
      activities: arr("activities").length,
      watchGroups: arr("watchGroups").length,
      fundTransactions: arr("fundTransactions").length,
      userSettings: arr("userSettings").length,
      celebs: arr("celebs").length,
      profile: (d.profile as { nickname?: unknown } | undefined)?.nickname ? 1 : 0
    }
  };
}

/** 校验与当前账号相关的引用关系；预览和正式导入都调用，不产生写入。 */
export function validateBackupAccess(payload: unknown, userId: string, isAdmin: boolean) {
  const p = payload as { data?: Record<string, unknown> };
  const d = p.data ?? {};
  const records = Array.isArray(d.records) ? d.records as Record<string, unknown>[] : [];
  const orders = Array.isArray(d.tradeOrders) ? d.tradeOrders as Record<string, unknown>[] : [];
  const importedRecordIds = new Set(records.map((row) => text(row.id, "records.id", 128, true)));
  const importedRecordCodes = new Set(records.map((row) => `${text(row.market, "records.market", 20).toUpperCase()}:${text(row.code, "records.code", 40).toUpperCase()}`));
  const db = getDb();
  for (const order of orders) {
    const recordId = text(order.record_id, "tradeOrders.record_id", 128, true);
    const stockKey = `${text(order.market, "tradeOrders.market", 20).toUpperCase()}:${text(order.code, "tradeOrders.code", 40).toUpperCase()}`;
    if (!importedRecordIds.has(recordId) && !importedRecordCodes.has(stockKey) && !db.prepare("SELECT 1 FROM records WHERE id = ? AND user_id = ?").get(recordId, userId)) {
      throw new Error("订单引用了不属于当前用户的持仓");
    }
  }
  if (isAdmin) {
    const settings = (d.siteSettings ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(settings)) {
      if (ENV_SETTING_KEYS.has(key)) continue;
      if (!SITE_SETTING_KEYS.has(key)) throw new Error(`站点设置「${key.slice(0, 40)}」不允许导入`);
    }
  }
  const nickname = (d.profile as { nickname?: unknown } | undefined)?.nickname;
  if (nickname !== undefined) text(nickname, "profile.nickname", 20);
}

function upsertRow(db: ReturnType<typeof getDb>, table: TableName, pk: string, row: Record<string, unknown>) {
  const keys = COLUMNS[table].filter((key) => Object.prototype.hasOwnProperty.call(row, key));
  if (!keys.length || !keys.includes(pk as never)) throw new Error(`${table} 缺少主键`);
  const sql =
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((k) => `@${k}`).join(",")}) ` +
    `ON CONFLICT(${pk}) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`).join(",")}`;
  db.prepare(sql).run(row);
}

export function restoreBackupPayload(payload: unknown, userId: string, isAdmin: boolean) {
  validateBackupPayload(payload); // 先做格式/字段校验
  validateBackupAccess(payload, userId, isAdmin);
  const p = payload as { format?: string; version?: number; data?: Record<string, unknown> };
  const db = getDb();
  const d = p.data ?? {};
  const asArr = (key: string): Record<string, unknown>[] =>
    Array.isArray(d[key]) ? (d[key] as Record<string, unknown>[]) : [];

  const mapOwnedId = (table: "records" | "trade_orders" | "activities" | "watch_groups" | "fund_transactions", rawId: unknown, prefix: string) => {
    const oldId = text(rawId, `${table}.id`, 128, true);
    const existing = db.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(oldId) as { user_id?: string } | undefined;
    return { oldId, id: existing?.user_id === userId ? oldId : newId(prefix) };
  };
  const groupIdMap = new Map<string, string>();
  const groups = asArr("watchGroups").map((g) => {
    const ids = mapOwnedId("watch_groups", g.id, "wg"); groupIdMap.set(ids.oldId, ids.id);
    return { id: ids.id, user_id: userId, name: text(g.name, "watchGroups.name", 100, true), icon: text(g.icon, "watchGroups.icon", 500), sort: numberValue(g.sort, "watchGroups.sort", false) ?? 0, visible: numberValue(g.visible, "watchGroups.visible", false) ?? -1, kind: enumValue(g.kind, "watchGroups.kind", ["custom", "system"], "custom"), market: text(g.market, "watchGroups.market", 20), created_at: text(g.created_at, "watchGroups.created_at", 64, true) };
  });
  const recordIdMap = new Map<string, string>();
  const recordCodeMap = new Map<string, string>();
  const records = asArr("records").map((r) => {
    const ids = mapOwnedId("records", r.id, "r"); recordIdMap.set(ids.oldId, ids.id);
    const sourceGroupId = text(r.watch_group_id, "records.watch_group_id", 128);
    const mappedGroupId = sourceGroupId ? groupIdMap.get(sourceGroupId) : "";
    const ownedGroup = sourceGroupId && !mappedGroupId ? db.prepare("SELECT id FROM watch_groups WHERE id = ? AND user_id = ?").get(sourceGroupId, userId) : undefined;
    const market = text(r.market, "records.market", 20, true);
    const code = text(r.code, "records.code", 40, true);
    recordCodeMap.set(`${market.toUpperCase()}:${code.toUpperCase()}`, ids.id);
    return { id: ids.id, user_id: userId, name: text(r.name, "records.name", 200, true), code, market, price: numberValue(r.price, "records.price", false) ?? 0, cost: numberValue(r.cost, "records.cost"), qty: numberValue(r.qty, "records.qty"), group_name: text(r.group_name, "records.group_name", 100), note: text(r.note, "records.note", 2000), updated_at: text(r.updated_at, "records.updated_at", 64, true), source: text(r.source, "records.source", 50), watch_group_id: mappedGroupId ?? (ownedGroup ? sourceGroupId : "") };
  });
  const orders = asArr("tradeOrders").map((o) => {
    const ids = mapOwnedId("trade_orders", o.id, "ord");
    const sourceRecordId = text(o.record_id, "tradeOrders.record_id", 128, true);
    const mappedRecordId = recordIdMap.get(sourceRecordId);
    const stockMappedRecordId = recordCodeMap.get(`${text(o.market, "tradeOrders.market", 20).toUpperCase()}:${text(o.code, "tradeOrders.code", 40).toUpperCase()}`);
    const ownedRecord = mappedRecordId || stockMappedRecordId ? undefined : db.prepare("SELECT id FROM records WHERE id = ? AND user_id = ?").get(sourceRecordId, userId);
    if (!mappedRecordId && !stockMappedRecordId && !ownedRecord) throw new Error("订单引用了不属于当前用户的持仓");
    let orderNo = text(o.order_no, "tradeOrders.order_no", 32);
    if (ids.id !== ids.oldId || !/^\d{10}$/.test(orderNo)) {
      do { orderNo = generateOrderNo(); } while (db.prepare("SELECT 1 FROM trade_orders WHERE order_no = ?").get(orderNo));
    }
    return { id: ids.id, user_id: userId, record_id: mappedRecordId ?? stockMappedRecordId ?? sourceRecordId, market: text(o.market, "tradeOrders.market", 20, true), code: text(o.code, "tradeOrders.code", 40, true), name: text(o.name, "tradeOrders.name", 200, true), side: enumValue(o.side, "tradeOrders.side", ["buy", "sell", "dividend"], "buy"), status: enumValue(o.status, "tradeOrders.status", ["filled", "cancelled", "pending", "expired"], "filled"), qty: numberValue(o.qty, "tradeOrders.qty", false), price: numberValue(o.price, "tradeOrders.price", false), fees: numberValue(o.fees, "tradeOrders.fees", false), amount: numberValue(o.amount, "tradeOrders.amount", false), realized_pnl: numberValue(o.realized_pnl, "tradeOrders.realized_pnl"), position_qty_after: numberValue(o.position_qty_after, "tradeOrders.position_qty_after", false), position_cost_after: numberValue(o.position_cost_after, "tradeOrders.position_cost_after"), broker: text(o.broker, "tradeOrders.broker", 100), note: text(o.note, "tradeOrders.note", 2000), traded_at: text(o.traded_at, "tradeOrders.traded_at", 64, true), created_at: text(o.created_at, "tradeOrders.created_at", 64, true), position_qty_before: numberValue(o.position_qty_before, "tradeOrders.position_qty_before"), position_cost_before: numberValue(o.position_cost_before, "tradeOrders.position_cost_before"), order_no: orderNo, order_type: enumValue(o.order_type, "tradeOrders.order_type", ["market", "limit", "stop", "stop_limit"], "limit"), trigger_price: numberValue(o.trigger_price, "tradeOrders.trigger_price"), tif: enumValue(o.tif, "tradeOrders.tif", ["day", "gtc"], "day"), expires_at: o.expires_at ? text(o.expires_at, "tradeOrders.expires_at", 64) : null, session: text(o.session, "tradeOrders.session", 32), trigger_status: text(o.trigger_status, "tradeOrders.trigger_status", 32) };
  });
  const acts = asArr("activities").map((a) => { const ids = mapOwnedId("activities", a.id, "a"); return { id: ids.id, user_id: userId, action: text(a.action, "activities.action", 30, true), stock_name: text(a.stock_name, "activities.stock_name", 200, true), stock_code: text(a.stock_code, "activities.stock_code", 40, true), created_at: text(a.created_at, "activities.created_at", 64, true), market: text(a.market, "activities.market", 20), price: numberValue(a.price, "activities.price"), cost: numberValue(a.cost, "activities.cost"), qty: numberValue(a.qty, "activities.qty") }; });
  const fundTransactions = asArr("fundTransactions").map((item) => { const ids = mapOwnedId("fund_transactions", item.id, "fund"); return { id: ids.id, user_id: userId, currency: enumValue(item.currency, "fundTransactions.currency", ["USD", "EUR", "HKD", "CNY", "JPY", "KRW", "SGD"], "USD"), type: enumValue(item.type, "fundTransactions.type", ["opening", "deposit", "withdrawal", "adjustment"], "deposit"), amount: numberValue(item.amount, "fundTransactions.amount", false), direction: numberValue(item.direction, "fundTransactions.direction", false), note: text(item.note, "fundTransactions.note", 200), occurred_at: text(item.occurred_at, "fundTransactions.occurred_at", 64, true), created_at: text(item.created_at, "fundTransactions.created_at", 64, true) }; });
  const userSettings = asArr("userSettings").slice(0, 1).map((u) => ({ user_id: userId, fire: jsonText(u.fire, "userSettings.fire", 1_000_000) }));
  const celebs = asArr("celebs").map((c) => ({ id: text(c.id, "celebs.id", 128, true), name: text(c.name, "celebs.name", 200, true), title: text(c.title, "celebs.title", 200), avatar: text(c.avatar, "celebs.avatar", 1000), enabled: numberValue(c.enabled, "celebs.enabled", false) ?? 1, sort: numberValue(c.sort, "celebs.sort", false) ?? 0, source_kind: text(c.source_kind, "celebs.source_kind", 30), cik: text(c.cik, "celebs.cik", 20), entity: text(c.entity, "celebs.entity", 200), source_label: text(c.source_label, "celebs.source_label", 200), holdings_json: jsonText(c.holdings_json, "celebs.holdings_json", 5_000_000), trades_json: jsonText(c.trades_json, "celebs.trades_json", 5_000_000), returns_json: jsonText(c.returns_json, "celebs.returns_json", 1_000_000), created_at: text(c.created_at, "celebs.created_at", 64, true), updated_at: text(c.updated_at, "celebs.updated_at", 64, true), stock_icons_json: jsonText(c.stock_icons_json, "celebs.stock_icons_json", 1_000_000), refresh_hours: numberValue(c.refresh_hours, "celebs.refresh_hours", false) ?? 0 }));

  const tx = db.transaction(() => {
    for (const g of groups) upsertRow(db, "watch_groups", "id", g);
    for (const r of records) upsertRow(db, "records", "id", r);
    for (const o of orders) upsertRow(db, "trade_orders", "id", o);
    for (const a of acts) upsertRow(db, "activities", "id", a);
    for (const item of fundTransactions) upsertRow(db, "fund_transactions", "id", item);
    for (const u of userSettings) upsertRow(db, "user_settings", "user_id", u);
    // 站点级数据（名人持仓 / 站点设置）仅管理员可写入；普通用户即使备份里带了也会忽略，防止注入
    if (isAdmin) {
      for (const c of celebs) upsertRow(db, "celebs", "id", c);
      const ss = (d.siteSettings ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(ss)) {
        if (ENV_SETTING_KEYS.has(k)) continue;
        if (!SITE_SETTING_KEYS.has(k)) throw new Error(`站点设置「${k.slice(0, 40)}」不允许导入`);
        db.prepare("INSERT INTO site_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, text(v, `siteSettings.${k}`, 1_000_000));
      }
    }
    const profile = (d.profile ?? {}) as { nickname?: unknown; avatar?: unknown };
    const nickname = typeof profile.nickname === "string" ? text(profile.nickname.trim(), "profile.nickname", 20) : "";
    if (nickname) db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickname, userId);
  });
  tx();

  return {
    counts: {
      records: records.length,
      tradeOrders: orders.length,
      activities: acts.length,
      watchGroups: groups.length,
      fundTransactions: fundTransactions.length,
      userSettings: userSettings.length,
      celebs: isAdmin ? celebs.length : 0,
      siteSettings: isAdmin ? Object.keys((d.siteSettings ?? {}) as Record<string, unknown>).length : 0,
      profile: (d.profile as { nickname?: unknown })?.nickname ? 1 : 0
    },
    importedAt: new Date().toISOString()
  };
}
