import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { RecordsError } from "./recordsContract";
import { ALLOCATION_CATEGORIES, type AllocationInput, type AllocationAccount } from "./assetAllocationTypes";
import { captureAllocationBasis } from "./allocationReconciliation";
import { getSiteSettings } from "./settings";
import { readRecord } from "./store";

export interface AllocationRow { source_id: string; name: string; currency: string; amount: number; category: AllocationInput["category"]; excluded: number; amount_mode: "automatic" | "statement"; statement_basis: string; revision: number; updated_at: string; }
export function allocationRows(userId: string): AllocationRow[] {
  return getDb().prepare("SELECT source_id,name,currency,amount,category,excluded,amount_mode,statement_basis,revision,updated_at FROM asset_allocation_accounts WHERE user_id=? ORDER BY updated_at,source_id").all(userId) as AllocationRow[];
}
export function allocationRevisions(userId: string) {
  return new Map((getDb().prepare("SELECT source_id,revision FROM asset_allocation_revisions WHERE user_id=?").all(userId) as { source_id: string; revision: number }[]).map(r => [r.source_id, r.revision]));
}
export function parseAllocationInput(raw: unknown): AllocationInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecordsError("账户参数无效");
  const b = raw as Record<string, unknown>;
  if (Object.keys(b).some(k => !["id", "requestId", "revision", "name", "currency", "amount", "category", "excluded", "amountMode", "amountChanged"].includes(k)) ||
      typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 80 || typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency) ||
      typeof b.amount !== "number" || !Number.isFinite(b.amount) || Math.abs(b.amount) > 1e12 ||
      typeof b.category !== "string" || !(ALLOCATION_CATEGORIES as readonly string[]).includes(b.category) ||
      typeof b.excluded !== "boolean" || b.amountMode !== undefined && b.amountMode !== "automatic" && b.amountMode !== "statement" || b.amountChanged !== undefined && typeof b.amountChanged !== "boolean" || !Number.isSafeInteger(b.revision) || Number(b.revision) < 0 ||
      b.id !== undefined && (typeof b.id !== "string" || b.id.length > 250 || !b.id) || b.requestId !== undefined && (typeof b.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(b.requestId))) throw new RecordsError("名称、币种或金额无效");
  if (b.category === "debt" && b.amount < 0) throw new RecordsError("负债请输入正数");
  return { id: b.id as string | undefined, requestId: b.requestId as string | undefined, revision: Number(b.revision), name: b.name.trim(), currency: b.currency, amount: b.amount, category: b.category as AllocationInput["category"], excluded: b.excluded, amountMode: b.amountMode as AllocationInput["amountMode"], amountChanged: b.amountChanged as boolean | undefined };
}
export function saveAllocationAccount(userId: string, input: AllocationInput, sources: Set<string>, source?: AllocationAccount) {
  const db = getDb(), id = input.id ?? `manual:${input.requestId ?? randomUUID()}`;
  const row = allocationRows(userId).find(r => r.source_id === id);
  if (input.id && !input.id.startsWith("manual:") && !sources.has(id)) throw new RecordsError("关联来源已移除", 404);
  if (input.id && !row && !sources.has(id)) throw new RecordsError("账户不存在", 404);
  if (input.amountMode === "automatic" && (!sources.has(id) || id.startsWith("manual:"))) throw new RecordsError("只有关联账户可使用自动金额");
  if ((allocationRevisions(userId).get(id) ?? 0) !== input.revision) throw new RecordsError("账户已更新，请重新核对", 409, 40902);
  if (!row && allocationRows(userId).length >= 256) throw new RecordsError("账户数量已达上限");
  const mode = input.amountMode ?? "statement";
  const metadataOnly = input.amountChanged === false && row && row.currency === input.currency && row.category === input.category && row.amount_mode === mode;
  if (input.amountChanged === false && !metadataOnly && !(mode === "automatic" && !row && sources.has(id))) throw new RecordsError("金额或核对方式已变化，请重新核对");
  const amount = metadataOnly ? row.amount : input.amount;
  let basis = metadataOnly ? row.statement_basis : "";
  if (!metadataOnly && mode === "statement" && source) {
    if (source.sourceAmount === null || source.sourceAmount === undefined) throw new RecordsError("缺少核对基准市值或汇率");
    basis = JSON.stringify(captureAllocationBasis(userId, id, input.currency, source.sourceAmount));
  }
  db.prepare(`INSERT INTO asset_allocation_accounts(user_id,source_id,name,currency,amount,category,excluded,amount_mode,statement_basis,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,source_id) DO UPDATE SET name=excluded.name,currency=excluded.currency,amount=excluded.amount,category=excluded.category,excluded=excluded.excluded,amount_mode=excluded.amount_mode,statement_basis=excluded.statement_basis,revision=excluded.revision,updated_at=excluded.updated_at`)
    .run(userId, id, input.name, input.currency, amount, input.category, Number(input.excluded), mode, basis, input.revision + 1, new Date().toISOString());
  return { id, revision: input.revision + 1 };
}
export function deleteAllocationAccount(userId: string, id: string, revision: number, preserveName = false) {
  const db = getDb();
  const result = preserveName
    ? db.prepare("UPDATE asset_allocation_accounts SET amount_mode='automatic',statement_basis='',excluded=0,updated_at=? WHERE user_id=? AND source_id=? AND revision=?").run(new Date().toISOString(), userId, id, revision)
    : db.prepare("DELETE FROM asset_allocation_accounts WHERE user_id=? AND source_id=? AND revision=?").run(userId, id, revision);
  if (!result.changes) throw new RecordsError("账户已更新或不存在，请重新读取", 409, 40902);
}

/** Change the real owned record's broker; valuation and trade quantities stay untouched. */
export function assignAllocationBroker(userId: string, raw: unknown) {
  return getDb().transaction(() => assignBroker(userId, raw))();
}
function assignBroker(userId: string, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecordsError("关联参数无效");
  const b = raw as { brokerId?: unknown; records?: unknown };
  if (Object.keys(b).some(k => !["brokerId", "records"].includes(k)) || typeof b.brokerId !== "string" || !Array.isArray(b.records) || !b.records.length || b.records.length > 200) throw new RecordsError("请选择券商和持仓");
  const broker = getSiteSettings().groups.find(g => g.id === b.brokerId);
  if (!broker) throw new RecordsError("券商不存在", 404);
  const seen = new Set<string>();
  for (const value of b.records) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["id", "revision"].includes(k)) || typeof value.id !== "string" || !Number.isSafeInteger(value.revision) || seen.has(value.id)) throw new RecordsError("持仓标识或版本无效");
    seen.add(value.id);
    const record = readRecord(userId, value.id);
    if (!record) throw new RecordsError("持仓不存在", 404);
    if (record.revision !== value.revision) throw new RecordsError("持仓已更新，请重新读取", 409, 40902);
  }
  const update = getDb().prepare("UPDATE records SET group_name=?,updated_at=? WHERE id=? AND user_id=?");
  for (const id of seen) update.run(broker.name, new Date().toISOString(), id, userId);
  return { brokerId: broker.id, recordIds: [...seen] };
}
