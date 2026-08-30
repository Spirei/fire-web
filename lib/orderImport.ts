import { randomBytes } from "crypto";
import { getDb } from "./db";
import type { Market } from "./types";
import { refreshEconomicRealizedPnl } from "./orders";

/**
 * 券商订单导入：把「订单状态=已成交」的券商订单接入 trade_orders。
 * 规则（详见 docs/broker-orders-format.md）：
 *  - 只导入已成交；按 内容指纹 (market, code, traded_at, side, qty, price) 幂等去重
 *    （历史订单 order_no 可能是随机回退号，不能只按 order_no 判重）；
 *  - 代码剥交易所后缀后匹配记录；无记录则新建（qty/cost 置空、归入全部+对应市场）；
 *  - 每股按成交时间重放，快照链自洽，最终数量必须等于记录数量，否则整组跳过；
 *  - 期权代码跳过；窗口外单边卖出的持仓按窗口外基准导入、成本置空。
 */

export interface ImportOrderInput {
  status: string;
  market: string;
  code: string;
  name: string;
  side: string;
  tradedAt: string; // 原始文本（如 2026-08-04 16:04:15 ET）
  avgPrice: string;
  qty: string;
  amount: string;
  orderNo: string;
  [key: string]: string;
}

export interface ImportGroupResult {
  market: string;
  code: string;
  name: string;
  recordName: string | null;
  createdRecord: boolean;
  orderCount: number;
  finalQty: number;
  action: "imported" | "skipped" | "option" | "exists";
  reason?: string;
}

export interface ImportResult {
  totalFilled: number;
  imported: number;
  skipped: number;
  duplicated: number;
  groups: ImportGroupResult[];
}

const EXCHANGE_SUFFIX = /\.(AM|N|OQ|PS|K)$/i;
const OPTION_CODE = /^[A-Z]+\d{6}[CP]\d+$/;

export function normalizeImportCode(code: string): string {
  return code.replace(EXCHANGE_SUFFIX, "").toUpperCase();
}

function isOption(code: string): boolean {
  return OPTION_CODE.test(code.toUpperCase());
}

/** 券商本地时间 → UTC ISO。US=美东（含 DST），HK=北京时间（+8 无 DST）。 */
export function parseTradedAt(raw: string, market: string): string {
  const text = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})( ET)?$/.exec(text);
  if (!m) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  const hasEt = !!m[7];
  let guess = target;
  if (hasEt) {
    // 用 Intl 反推美东偏移（含 DST），迭代 2~3 次收敛
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    for (let i = 0; i < 3; i++) {
      const parts = fmt.formatToParts(new Date(guess));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const shown = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour") % 24, +get("minute"), +get("second"));
      const delta = target - shown;
      if (delta === 0) break;
      guess += delta;
    }
  } else if (market === "HK") {
    guess = target - 8 * 3600 * 1000; // 北京时间 = UTC+8
  }
  return new Date(guess).toISOString();
}

function replayApply(side: string, qty: number, price: number, posQty: number, posCost: number | null, realized: number | null): { qty: number; cost: number | null; realized: number | null } {
  if (side === "股息") {
    // 股息入账：不改变持仓数量与成本，每股股息 × 股数记为现金收入
    return { qty: posQty, cost: posCost, realized: (realized ?? 0) + qty * price };
  }
  if (side === "买") {
    if (posCost === null) return { qty: posQty + qty, cost: null, realized };
    const total = posQty * posCost + qty * price;
    const q2 = posQty + qty;
    return { qty: q2, cost: q2 > 0 ? total / q2 : null, realized };
  }
  if (posCost === null) return { qty: posQty - qty, cost: null, realized: null };
  const r = (price - posCost) * qty;
  return { qty: posQty - qty, cost: posCost, realized: (realized ?? 0) + r };
}

function field(row: ImportOrderInput, ...names: string[]): string {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
  }
  return "";
}

/** 券商导出行方向识别：买 / 卖 / 股息（方向列或业务类型含 股息/红利/分红/派息）。 */
function sideOf(row: ImportOrderInput): "buy" | "sell" | "dividend" | null {
  const dir = String(field(row, "方向", "E")).trim();
  if (dir.includes("买")) return "buy";
  if (dir.includes("卖")) return "sell";
  const extra = field(row, "方向", "业务名称", "业务类型", "交易类型", "摘要", "类型");
  if (/股息|红利|分红|派息|dividend/i.test(dir + extra)) return "dividend";
  return null;
}

/**
 * 导入券商订单。rows 为 readBrokerOrderSheet 解析出的全部行（含非已成交）。
 * dryRun=true 只计算并返回结果，不写库。
 */
export function importBrokerOrders(userId: string, rawRows: ImportOrderInput[], dryRun = false): ImportResult {
  const db = getDb();
  // 只取已成交 + 有效数量/均价；按订单号去重（两份导出可能有重叠，跨行判重）
  const seenOrderNo = new Set<string>();
  const filled = rawRows.filter((row) => {
    if (field(row, "订单状态") !== "已成交") return false;
    if (!sideOf(row)) return false;
    const qty = Number(field(row, "成交数量", "M") || "0");
    const price = Number(field(row, "成交均价", "L") || "0");
    if (qty <= 0 || price <= 0) return false;
    const no = String(field(row, "订单号", "T")).trim();
    if (no && seenOrderNo.has(no)) return false;
    if (no) seenOrderNo.add(no);
    return true;
  });

  // 现有记录（market, code）索引
  const records = db
    .prepare("SELECT id, name, code, market, qty, cost, watch_group_id FROM records WHERE user_id = ?")
    .all(userId) as Array<{ id: string; name: string; code: string; market: string; qty: number | null; cost: number | null; watch_group_id: string }>;
  const byCode = new Map<string, (typeof records)[number]>();
  for (const rec of records) {
    byCode.set(`${rec.market.toUpperCase()}:${normalizeImportCode(rec.code)}`, rec);
  }

  // 库内已有订单的内容指纹（排除重复）
  const existingRows = db
    .prepare("SELECT record_id, market, code, traded_at, side, qty, price, order_no FROM trade_orders WHERE user_id = ?")
    .all(userId) as Array<{ record_id: string; market: string; code: string; traded_at: string; side: string; qty: number; price: number; order_no: string }>;
  const existingFingerprint = new Map<string, string>(); // 指纹 -> order_no（券商号优先）
  for (const row of existingRows) {
    const rec = byCode.get(`${row.market.toUpperCase()}:${normalizeImportCode(row.code)}`);
    const fp = fingerprint(rec?.id ?? row.record_id, row.traded_at, row.side, row.qty, row.price);
    const orderNo = String(row.order_no || "");
    if (!existingFingerprint.has(fp) || !/^\d{16,}$/.test(orderNo)) {
      existingFingerprint.set(fp, orderNo);
    }
  }

  // 按 (market, code) 分组
  const groupsMap = new Map<string, { market: string; code: string; name: string; rows: ImportOrderInput[] }>();
  for (const row of filled) {
    const market = String(field(row, "市场", "B")).trim().toUpperCase() || "US";
    const code = normalizeImportCode(field(row, "股票代码", "C"));
    const key = `${market}:${code}`;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, { market, code, name: field(row, "股票名称", "D").trim(), rows: [] });
    }
    groupsMap.get(key)!.rows.push(row);
  }

  const groups: ImportGroupResult[] = [];
  let imported = 0;
  let duplicated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  // 计算 + 写入共用同一循环：dryRun 时跳过写库语句（记录/订单 INSERT），其余照常统计
  const processGroups = () => {
    for (const { market, code, name, rows } of groupsMap.values()) {
      if (isOption(code)) {
        skipped += rows.length;
        groups.push({ market, code, name, recordName: null, createdRecord: false, orderCount: rows.length, finalQty: 0, action: "option", reason: "期权不支持" });
        continue;
      }
      const sorted = [...rows].sort((a, b) => field(a, "委托时间", "K").localeCompare(field(b, "委托时间", "K")));
      const net = sorted.reduce((sum, row) => {
        const side = sideOf(row);
        return sum + (side === "buy" ? 1 : side === "sell" ? -1 : 0) * Number(field(row, "成交数量", "M"));
      }, 0);
      let rec = byCode.get(`${market}:${code}`);
      const curQty = rec ? Number(rec.qty ?? 0) : 0;
      const baseQty = curQty - net;
      if (baseQty < -1e-6) {
        skipped += rows.length;
        groups.push({ market, code, name, recordName: rec?.name ?? null, createdRecord: false, orderCount: rows.length, finalQty: curQty, action: "skipped", reason: "订单净量与当前持仓矛盾（导出缺单）" });
        continue;
      }
      const baseCost = baseQty > 1e-6 ? null : 0;
      let posQty = Math.max(0, baseQty);
      let posCost: number | null = baseCost;
      let realized: number | null = 0;
      const snap: Array<{ row: ImportOrderInput; beforeQty: number; beforeCost: number | null; realized: number | null; tradedAt: string; side: string; qty: number; price: number; isNew: boolean }> = [];
      for (const row of sorted) {
        const qty = Number(field(row, "成交数量", "M"));
        const price = Number(field(row, "成交均价", "L"));
        const tradedAt = parseTradedAt(field(row, "委托时间", "K"), market);
        const side = sideOf(row) ?? (field(row, "方向", "E") === "买" ? "buy" : "sell");
        const fp = fingerprint(rec?.id ?? `pending:${market}:${code}`, tradedAt, side, qty, price);
        const isNew = !existingFingerprint.has(fp);
        const beforeQty = posQty;
        const beforeCost = posCost;
        snap.push({ row, beforeQty, beforeCost, realized, tradedAt, side, qty, price, isNew });
        const next = replayApply(side === "buy" ? "买" : side === "sell" ? "卖" : "股息", qty, price, posQty, posCost, realized);
        posQty = next.qty;
        posCost = next.cost;
        realized = next.realized;
      }
      if (Math.abs(posQty - curQty) > 1e-6) {
        skipped += rows.length;
        groups.push({ market, code, name, recordName: rec?.name ?? null, createdRecord: false, orderCount: rows.length, finalQty: posQty, action: "skipped", reason: "重放最终数量与记录不一致" });
        continue;
      }
      const newCount = snap.filter((item) => item.isNew).length;
      if (newCount === 0) {
        duplicated += rows.length;
        groups.push({ market, code, name, recordName: rec?.name ?? null, createdRecord: false, orderCount: rows.length, finalQty: curQty, action: "exists", reason: "已导入" });
        continue;
      }

      // 无记录 → 新建（qty/cost 置空，price 用最后一笔成交均价）
      let recordName = rec?.name ?? null;
      let createdRecord = false;
      if (!rec) {
        if (!dryRun) {
          const id = "r-" + randomBytes(8).toString("hex");
          const lastPrice = Number(field(sorted[sorted.length - 1], "成交均价", "L"));
          db.prepare(
            `INSERT INTO records (id, user_id, name, code, market, price, cost, qty, group_name, watch_group_id, note, source, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '', '', '', 'broker-import', ?)`
          ).run(id, userId, name, code, market as Market, lastPrice, now);
          rec = { id, name, code, market, qty: null, cost: null, watch_group_id: "" };
          byCode.set(`${market}:${code}`, rec);
        }
        recordName = name;
        createdRecord = true;
      }

      if (!dryRun) {
        for (const snapItem of snap) {
          const { row, beforeQty, beforeCost, realized: beforeRealized, tradedAt, side, qty, price } = snapItem;
          if (!snapItem.isNew) continue;
          const amount = Number(field(row, "成交金额", "N") || qty * price);
          const qAfter = side === "dividend" ? beforeQty : beforeQty + (side === "buy" ? qty : -qty);
          let costAfter: number | null;
          if (side === "dividend") {
            costAfter = beforeCost;
          } else if (side === "buy") {
            costAfter = beforeCost === null || qAfter <= 0 ? null : (beforeQty * beforeCost + qty * price) / qAfter;
          } else {
            costAfter = qAfter > 0 ? beforeCost : null;
          }
          const orderId = "o-" + randomBytes(8).toString("hex");
          const orderNo = String(field(row, "订单号", "T")).trim();
          db.prepare(
            `INSERT INTO trade_orders
             (id, order_no, user_id, record_id, market, code, name, side, status, qty, price, fees, amount, realized_pnl,
              position_qty_before, position_cost_before, position_qty_after, position_cost_after, broker, note, traded_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`
          ).run(
            orderId, orderNo, userId, rec!.id, market, code, recordName, side,
            qty, price, 0, amount, beforeRealized,
            beforeQty, beforeCost, qAfter, costAfter,
            field(row, "币种", "J") || market, tradedAt, now
          );
        }
        refreshEconomicRealizedPnl(userId, rec!.id);
      }
      groups.push({ market, code, name, recordName, createdRecord, orderCount: newCount, finalQty: posQty, action: "imported" });
      imported += newCount;
    }
  };

  if (dryRun) {
    processGroups();
  } else {
    db.transaction(processGroups)();
  }

  return { totalFilled: filled.length, imported, skipped, duplicated, groups };
}

/** 内容指纹：与订单内容唯一对应的键（忽略 order_no 与记录成本） */
function fingerprint(recordId: string, tradedAt: string, side: string, qty: number, price: number): string {
  // 归一化毫秒：库内历史订单（Python 导入）存 "…Z" 无毫秒，新导入 toISOString 带毫秒
  const t = tradedAt.replace(/\.\d{3}Z$/, "Z");
  return `${recordId}|${t}|${side}|${qty}|${price}`;
}
