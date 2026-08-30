/**
 * 股息结算日自动入账（惰性任务）。
 *
 * 服务器有访问时每 15 分钟检查一次：对有持仓的记录拉取富途股息（走 dividend_cache），
 * 当某期股息的派息日（dividend_payable_date）已到且尚未自动生成过订单时，
 * 按「除净日持仓数量 × 每股股息」自动创建 dividend 订单（计入已实现收益，不改变持仓）。
 * 去重键：订单备注中的 [auto:dividend:除净日] 标记，同一期只生成一次。
 */
import { getDb } from "./db";
import { getDividends } from "./dividends";
import { executeOrder } from "./orders";

const THROTTLE_MS = 15 * 60 * 1000;
const MAX_RECORDS_PER_RUN = 60;

let lastRun = 0;
let running = false;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 重放订单账本，返回某日期（除净日 00:00）之前的持仓数量。只关心数量，卖出封顶为 0，不抛错。 */
function positionAtDate(userId: string, recordId: string, cutoff: Date): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM trade_orders
       WHERE user_id = ? AND record_id = ? AND status = 'filled'
       ORDER BY traded_at ASC, created_at ASC`
    )
    .all(userId, recordId) as Record<string, unknown>[];
  let qty = 0;
  const first = rows[0];
  if (first) {
    const beforeQty = Number(first.position_qty_before);
    if (Number.isFinite(beforeQty)) {
      qty = beforeQty;
    }
  }
  const cutoffMs = cutoff.getTime();
  for (const row of rows) {
    if (new Date(String(row.traded_at)).getTime() >= cutoffMs) break;
    const side = String(row.side);
    const q = Number(row.qty);
    if (side === "buy") qty += q;
    else if (side === "sell") qty = Math.max(0, qty - q);
    // dividend 不改变持仓
  }
  return qty;
}

async function settleForRecord(userId: string, record: { id: string; market: string; code: string }): Promise<number> {
  const { ok, dividends } = await getDividends(record.market, record.code);
  if (!ok || dividends.length === 0) return 0;
  const today = todayKey();
  const db = getDb();
  let created = 0;
  for (const div of dividends) {
    // A股无到账日（payDate），按除净日触发；其余市场按派息日触发
    const triggerDate = div.payDate ?? div.exDate ?? div.recordDate;
    if (!triggerDate || triggerDate > today) continue;
    const exKey = div.exDate ?? triggerDate;
    if (!div.amount || !(div.amount > 0)) continue;
    const marker = `[auto:dividend:${exKey}]`;
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
