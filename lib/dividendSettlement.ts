/**
 * 股息结算日自动入账（惰性任务）。
 *
 * 服务器有访问时每 15 分钟检查一次：对有持仓的记录拉取富途股息（走 dividend_cache），
 * 当某期股息的派息日（dividend_payable_date）已到且尚未自动生成过订单时，
 * 按「除净日持仓数量 × 每股股息」自动创建 dividend 订单（计入已实现收益，不改变持仓）。
 * 去重键：订单备注中的 [auto:dividend:除净日] 标记，同一期只生成一次。
 */
import { getDb } from "./db";
import { getDividends, type DividendLedgerRow, type DividendPhase, type DividendRecord } from "./dividends";
import { deleteOrder, executeOrder } from "./orders";

const THROTTLE_MS = 15 * 60 * 1000;
const MAX_RECORDS_PER_RUN = 60;

let lastRun = 0;
let running = false;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayKey(value: string) {
  return value.slice(0, 10);
}

function filledTrades(userId: string, recordId: string) {
  return getDb()
    .prepare(
      `SELECT side, qty, traded_at, note FROM trade_orders
       WHERE user_id = ? AND record_id = ? AND status = 'filled'
       ORDER BY traded_at ASC, created_at ASC`
    )
    .all(userId, recordId) as Array<{ side: string; qty: number; traded_at: string; note: string }>;
}

/** 首次买入日。没有买入订单则没有持股起点，买入前的派息一律不入账。 */
export function firstBuyDate(userId: string, recordId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT traded_at FROM trade_orders
       WHERE user_id = ? AND record_id = ? AND status = 'filled' AND side = 'buy'
       ORDER BY traded_at ASC, created_at ASC LIMIT 1`
    )
    .get(userId, recordId) as { traded_at: string } | undefined;
  return row?.traded_at ? dayKey(row.traded_at) : null;
}

/** 重放买入/卖出，返回除息日 00:00 之前的持股数。从 0 开始，不沿用首笔订单的期初快照。 */
function positionAtDate(userId: string, recordId: string, cutoff: Date): number {
  const cutoffMs = cutoff.getTime();
  let qty = 0;
  for (const row of filledTrades(userId, recordId)) {
    if (new Date(String(row.traded_at)).getTime() >= cutoffMs) break;
    if (row.side === "buy") qty += Number(row.qty) || 0;
    else if (row.side === "sell") qty = Math.max(0, qty - (Number(row.qty) || 0));
  }
  return qty;
}

function exKeyOf(div: { exDate?: string | null; payDate?: string | null; recordDate?: string | null }) {
  return div.exDate ?? div.payDate ?? div.recordDate ?? "";
}

function triggerOf(div: { exDate?: string | null; payDate?: string | null; recordDate?: string | null }) {
  return div.payDate ?? div.exDate ?? div.recordDate ?? "";
}

function markerOf(exKey: string) {
  return `[auto:dividend:${exKey}]`;
}

function isBooked(userId: string, recordId: string, div: DividendRecord, trades: Array<{ side: string; traded_at: string; note: string }>) {
  const exKey = exKeyOf(div);
  const marker = exKey ? markerOf(exKey) : "";
  return trades.some((row) => {
    if (row.side !== "dividend") return false;
    if (marker && row.note?.includes(marker)) return true;
    const day = dayKey(row.traded_at);
    return Boolean(exKey && (day === div.exDate || day === div.payDate || day === div.recordDate));
  });
}

export function inspectHoldingDividends(userId: string, recordId: string, dividends: DividendRecord[]): { firstBuyDate: string | null; rows: DividendLedgerRow[] } {
  const start = firstBuyDate(userId, recordId);
  const today = todayKey();
  const trades = filledTrades(userId, recordId);
  return {
    firstBuyDate: start,
    rows: dividends.map((div) => {
      const exKey = exKeyOf(div);
      const due = triggerOf(div);
      const cutoff = exKey ? new Date(`${exKey}T00:00:00`) : due ? new Date(`${due}T00:00:00`) : null;
      const heldQty = cutoff && !Number.isNaN(cutoff.getTime()) ? positionAtDate(userId, recordId, cutoff) : 0;
      const booked = isBooked(userId, recordId, div, trades);
      let phase: DividendPhase = "info";
      if (div.kind !== "cash" || !(Number(div.amount) > 0)) phase = "info";
      else if (start && exKey && exKey < start) phase = "before";
      else if (!start) phase = "before";
      else if (due && due > today) phase = "pending";
      else if (booked) phase = "booked";
      else if (heldQty > 0) phase = "missing";
      else phase = "unowned";
      return { exDate: div.exDate, payDate: div.payDate, heldQty, booked, phase };
    })
  };
}

function purgeIneligibleAutoDividends(userId: string, recordId: string) {
  const start = firstBuyDate(userId, recordId);
  const rows = getDb()
    .prepare(
      `SELECT id, note FROM trade_orders
       WHERE user_id = ? AND record_id = ? AND status = 'filled' AND side = 'dividend' AND note LIKE '%[auto:dividend:%'`
    )
    .all(userId, recordId) as Array<{ id: string; note: string }>;
  for (const row of rows) {
    const marker = /\[auto:dividend:(\d{4}-\d{2}-\d{2})\]/.exec(row.note || "");
    const exKey = marker?.[1] || "";
    const ineligible = !start || (exKey && exKey < start) || (exKey && positionAtDate(userId, recordId, new Date(`${exKey}T00:00:00`)) <= 0);
    if (!ineligible) continue;
    try { deleteOrder({ userId, orderId: row.id }); } catch { /* 删掉买入前误入账的自动股息 */ }
  }
}

async function settleForRecord(userId: string, record: { id: string; market: string; code: string }): Promise<number> {
  purgeIneligibleAutoDividends(userId, record.id);
  const { ok, dividends } = await getDividends(record.market, record.code);
  if (!ok || dividends.length === 0) return 0;
  const today = todayKey();
  const start = firstBuyDate(userId, record.id);
  if (!start) return 0;
  const db = getDb();
  let created = 0;
  for (const div of dividends) {
    const triggerDate = triggerOf(div);
    if (!triggerDate || triggerDate > today) continue;
    const exKey = exKeyOf(div);
    if (!exKey || exKey < start) continue;
    if (!div.amount || !(div.amount > 0)) continue;
    const marker = markerOf(exKey);
    const exists = db
      .prepare(
        "SELECT 1 FROM trade_orders WHERE user_id = ? AND record_id = ? AND side = 'dividend' AND note LIKE ? LIMIT 1"
      )
      .get(userId, record.id, `%${marker}%`);
    if (exists) continue;

    const qty = positionAtDate(userId, record.id, new Date(`${exKey}T00:00:00`));
    if (!(qty > 0)) continue;
    const settleDate = new Date(`${triggerDate}T00:00:00`);
    if (Number.isNaN(settleDate.getTime())) continue;

    try {
      executeOrder({
        userId,
        recordId: record.id,
        side: "dividend",
        qty,
        price: div.amount,
        fees: 0,
        tradedAt: settleDate.toISOString(),
        note: `自动股息 ${div.amount}${div.currency ?? ""}（除净 ${exKey}）${marker}`
      });
      created += 1;
    } catch {
      /* 单条失败不影响其它标的 */
    }
  }
  return created;
}

/** 为单只持仓立即补齐已到派息日、尚未入账的股息。 */
export async function settleRecordDividends(userId: string, recordId: string): Promise<number> {
  const row = getDb().prepare("SELECT id, market, code FROM records WHERE id=? AND user_id=?").get(recordId, userId) as { id: string; market: string; code: string } | undefined;
  if (!row) throw new Error("持仓记录不存在");
  return settleForRecord(userId, row);
}

/** 惰性入口：15 分钟节流 + 单实例保护，返回本次自动生成的股息订单数。 */
export async function maybeRunDividendSettlement(): Promise<number> {
  const now = Date.now();
  if (running || now - lastRun < THROTTLE_MS) return 0;
  running = true;
  lastRun = now;
  try {
    const db = getDb();
    const records = db
      .prepare(
        `SELECT DISTINCT user_id, id, market, code FROM records
         WHERE qty IS NOT NULL AND qty > 0
         LIMIT ?`
      )
      .all(MAX_RECORDS_PER_RUN) as Array<{ user_id: string; id: string; market: string; code: string }>;
    let created = 0;
    for (const rec of records) {
      try {
        created += await settleForRecord(String(rec.user_id), { id: rec.id, market: rec.market, code: rec.code });
      } catch {
        /* 单只失败不影响其它标的 */
      }
    }
    return created;
  } finally {
    running = false;
  }
}
