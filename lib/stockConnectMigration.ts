import { getDb } from "./db";
import { readRecord } from "./store";
import { buildAssetAllocation } from "./assetAllocation";
import { allocationRows } from "./assetAllocationStore";
import { RecordsError } from "./recordsContract";

/** Explicit owner-confirmed identities only; never infer a trading channel from a Hong Kong code. */
export function migrateStockConnect(userId: string, requested: { id: string; revision: number }[], rates: Record<string, number>, options: { restoreAutomaticBrokerAmounts?: boolean } = {}) {
  if (!requested.length || new Set(requested.map(r => r.id)).size !== requested.length) throw new RecordsError("请选择不重复的港股记录");
  if (![rates.CNY, rates.HKD, rates.USD].every(r => Number.isFinite(r) && r > 0)) throw new RecordsError("缺少迁移核对汇率");
  const db = getDb();
  return db.transaction(() => {
    const selected = requested.map(item => {
      const record = readRecord(userId, item.id);
      if (!record) throw new RecordsError("持仓记录不存在", 404);
      if (record.market !== "HK") throw new RecordsError("只能迁移保留 HK 行情身份的记录");
      if (record.accountMarket !== "CN" && record.revision !== item.revision) throw new RecordsError("持仓已变化，请重新核对", 409);
      if (db.prepare("SELECT 1 FROM trade_orders WHERE user_id=? AND record_id=? AND status='pending'").get(userId, item.id)) throw new RecordsError("请先处理该股票的待成交委托");
      return record;
    });
    const previous = buildAssetAllocation(userId, rates, {}, "USD");
    const movingIds = new Set(selected.filter(r => r.accountMarket !== "CN").map(r => r.id));
    const sourceIds = new Set(previous.positions.filter(p => movingIds.has(p.id)).map(p => p.accountId));
    const restoreIds = new Set([...sourceIds].flatMap(id => [id, `${id.slice(0, id.lastIndexOf(":"))}:CNY`]));
    const restoredSources: string[] = [];
    if (options.restoreAutomaticBrokerAmounts) for (const overlay of allocationRows(userId)) {
      if (!restoreIds.has(overlay.source_id) || overlay.amount_mode !== "statement" || overlay.excluded) continue;
      const changed = db.prepare("UPDATE asset_allocation_accounts SET amount_mode='automatic',statement_basis='',updated_at=? WHERE user_id=? AND source_id=? AND revision=?")
        .run(new Date().toISOString(), userId, overlay.source_id, overlay.revision);
      if (changed.changes !== 1) throw new RecordsError("账户配置已变化，请重新核对", 409);
      restoredSources.push(overlay.source_id);
    }
    const before = buildAssetAllocation(userId, rates, {}, "USD");
    const affected = new Set(before.positions.filter(p => movingIds.has(p.id)).map(p => p.accountId));
    // Fixed statements contain cash or historical reconciliations; no currency conversion can replace those.
    const overlays = allocationRows(userId);
    if (before.positions.some(p => movingIds.has(p.id) && overlays.some(a => a.source_id === p.accountId && (a.amount_mode !== "automatic" || a.excluded)))) throw new RecordsError("原账户有手动核对或排除设置，请先恢复自动持仓金额");
    const now = new Date().toISOString();
    for (const record of selected) {
      if (record.accountMarket === "CN") continue;
      const changed = db.prepare("UPDATE records SET account_market='CN',updated_at=? WHERE user_id=? AND id=? AND revision=?")
        .run(now, userId, record.id, record.revision);
      if (changed.changes !== 1) throw new RecordsError("持仓已变化，请重新核对", 409);
    }
    const accountIds = new Set(buildAssetAllocation(userId, rates, {}, "USD").positions.map(p => p.accountId));
    const removedSources: string[] = [];
    for (const overlay of overlays) {
      if (!affected.has(overlay.source_id) || accountIds.has(overlay.source_id) || overlay.amount_mode !== "automatic") continue;
      const changed = db.prepare("DELETE FROM asset_allocation_accounts WHERE user_id=? AND source_id=? AND revision=?")
        .run(userId, overlay.source_id, overlay.revision);
      if (changed.changes !== 1) throw new RecordsError("账户配置已变化，请重新核对", 409);
      removedSources.push(overlay.source_id);
    }
    const after = buildAssetAllocation(userId, rates, {}, "USD");
    if (before.summary.complete !== after.summary.complete || before.summary.portfolioTotalAsset !== after.summary.portfolioTotalAsset
      || before.summary.totalAsset !== after.summary.totalAsset || before.summary.knownAsset !== after.summary.knownAsset) throw new RecordsError("迁移前后资产合计不一致，请核对账户声明");
    return { records: selected.map(r => readRecord(userId, r.id)!), restoredSources, removedSources, previousSummary: previous.summary, summary: after.summary };
  }).immediate();
}
