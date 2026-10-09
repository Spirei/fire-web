import { stockAccountError } from "./stockAccount";
import { createHash } from "node:crypto";
import { getDb } from "./db";
import { createRecord, deleteRecord, listRecords, logActivity, parseMarket, readRecord, toNumberOrEmpty, updateRecord } from "./store";
import { validateRecordFields } from "./recordValidation";
import type { RecordInput, StockRecord } from "./types";

export class RecordsError extends Error {
  constructor(message: string, public status = 400, public code = status * 100 + 1) { super(message); }
}
export function recordsDiscovery(version: 1 | 2) {
  const base = `/api/v${version}`;
  return { version: 1, supported: true, records_path: `${base}/records`, record_path: `${base}/records/{id}`,
    operation_path: `${base}/records/operations/{requestId}`, search_path: `${base}/search`,
    read_scope: "portfolio.read", write_scope: "portfolio.write", request_id_field: "requestId", revision_field: "revision",
    collection_revision_field: "collectionRevision", idempotency: "reject-duplicate-query-original", automatic_mutation_replay: false };
}
export function collectionRevision(userId: string) {
  const row = getDb().prepare("SELECT revision FROM record_collections WHERE user_id=?").get(userId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}
export function recordsSnapshot(userId: string, expected?: string | null) {
  return getDb().transaction(() => {
    const revision = collectionRevision(userId);
    if (expected !== undefined && expected !== null) {
      if (!/^(0|[1-9]\d*)$/.test(expected) || !Number.isSafeInteger(Number(expected))) throw new RecordsError("集合版本无效");
      if (revision !== Number(expected)) throw new RecordsError("记录已变化，请重新读取第一页", 409, 40902);
    }
    return { records: listRecords(userId), collectionRevision: revision };
  })();
}
export function recordSnapshot(userId: string, id: string) {
  return getDb().transaction(() => {
    const record = readRecord(userId, id);
    if (!record) throw new RecordsError("记录不存在", 404);
    return { record, collectionRevision: collectionRevision(userId) };
  })();
}
export function validRecordRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new RecordsError("requestId 须为小写 UUID");
  return value;
}
type Kind = "create" | "update" | "delete";
export interface RecordOperation {
  requestId: string; kind: Kind; recordId: string; state: "completed" | "failed";
  code: number; message: string; record: StockRecord | null; deleted: boolean;
  revision: number | null; collectionRevision: number; createdAt: string; completedAt: string;
}
export function readRecordOperation(userId: string, requestId: string): RecordOperation {
  validRecordRequestId(requestId);
  const row = getDb().prepare("SELECT result_json FROM record_operations WHERE user_id=? AND request_id=?").get(userId, requestId) as { result_json: string } | undefined;
  if (!row) throw new RecordsError("未找到已提交回执", 404);
  return JSON.parse(row.result_json) as RecordOperation;
}
function recordInput(body: Record<string, unknown>, strict: boolean): RecordInput {
  if (strict) {
    for (const [field, max, required] of [["name", 100, true], ["code", 40, true], ["market", 40, true], ["group", 100, true], ["note", 500, true], ["source", 50, false], ["watchGroupId", 100, false]] as const) {
      const value = body[field];
      if (value === undefined && !required) continue;
      if (typeof value !== "string" || value.length > max || (required && ["name", "code", "market"].includes(field) && !value.trim())) throw new RecordsError(`${field} 无效`);
    }
    for (const field of ["price", "cost", "qty"]) {
      const value = body[field];
      if (value !== null && value !== "" && (typeof value !== "number" || !Number.isFinite(value))) throw new RecordsError(`${field} 须为有限数值或空值`);
    }
  }
  const input: RecordInput = {
    name: String(body.name ?? "").trim(), code: String(body.code ?? "").trim(), market: parseMarket(String(body.market ?? "OTHER")),
    price: toNumberOrEmpty(body.price), cost: toNumberOrEmpty(body.cost), qty: toNumberOrEmpty(body.qty),
    group: String(body.group ?? "").trim().slice(0, 100), note: String(body.note ?? "").trim().slice(0, 500), source: String(body.source ?? "").trim().slice(0, 50)
  };
  if (body.accountMarket !== undefined) {
    const routeError = stockAccountError(input.market, body.accountMarket);
    if (routeError) throw new RecordsError(routeError);
    input.accountMarket = String(body.accountMarket);
  }
  // The new contract accepts owned group IDs; legacy versioned input keeps its old behavior.
  if (strict && body.watchGroupId !== undefined) input.watchGroupId = String(body.watchGroupId);
  const error = validateRecordFields(input.name, input.code, input.price, input.qty);
  if (error) throw new RecordsError(error);
  return input;
}

/** No awaits inside this transaction: consent, CAS, data, activity and receipt commit together. */
export function mutateRecords(userId: string, kind: Kind, id: string, body: unknown, authorize: () => string, web = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RecordsError("无效的请求体", 400, 40002);
  const values = body as Record<string, unknown>;
  const requestId = "requestId" in values ? validRecordRequestId(values.requestId) : undefined;
  const strict = requestId !== undefined;
  if (strict) {
    const allowed = kind === "delete" ? ["requestId", "revision"] : ["requestId", "revision", "name", "code", "market", "price", "cost", "qty", "group", "note", "source", "watchGroupId", "accountMarket"];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new RecordsError("请求含未知字段");
    if (kind === "create" && "revision" in values) throw new RecordsError("新建请求不接受 revision");
  }
  const revision = values.revision;
  if ((strict && kind !== "create") || "revision" in values) {
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new RecordsError("revision 须为正整数");
  }
  const input = kind === "delete" ? null : recordInput(values, strict);
  // Preserve the existing Web custom-group write input, without widening legacy App writes.
  if (web && input && values.watchGroupId !== undefined) input.watchGroupId = String(values.watchGroupId);
  const hash = createHash("sha256").update(JSON.stringify({ kind, id, input, revision: revision ?? null })).digest("hex");
  const db = getDb();
  return db.transaction(() => {
    if (authorize() !== userId) throw new RecordsError("连接已失效", 401);
    if (requestId && db.prepare("SELECT 1 FROM record_operations WHERE user_id=? AND request_id=?").get(userId, requestId)) throw new RecordsError("requestId 已使用，请只读查询原操作", 409, 40901);
    const old = kind === "create" ? null : readRecord(userId, id);
    let error: RecordsError | null = null;
    if (kind !== "create" && !old) error = new RecordsError("记录不存在", 404);
    else if (kind !== "create" && revision !== undefined && old?.revision !== revision) error = new RecordsError("记录已变化，请重新读取后确认", 409, 40902);
    else if (kind === "delete" && db.prepare("SELECT 1 FROM trade_orders WHERE user_id=? AND record_id=? LIMIT 1").get(userId, id)) error = new RecordsError("记录含成交历史，不能删除", 409, 40903);
    else if (input?.watchGroupId && !db.prepare("SELECT 1 FROM watch_groups WHERE user_id=? AND id=? AND kind='custom'").get(userId, input.watchGroupId)) error = new RecordsError("自选组不存在", 404);
    let record: StockRecord | null = null;
    if (!error) {
      if (kind === "create") record = createRecord(userId, input!);
      else if (kind === "update") record = updateRecord(id, userId, input!);
      else deleteRecord(id, userId);
      const activity = record ?? old!;
      logActivity(userId, kind === "create" ? "created" : kind === "update" ? "updated" : "deleted", activity.name, activity.code, activity);
    }
    const now = new Date().toISOString();
    const operation: RecordOperation = { requestId: requestId ?? "", kind, recordId: record?.id ?? id,
      state: error ? "failed" : "completed", code: error?.code ?? 0, message: error?.message ?? "ok", record,
      deleted: !error && kind === "delete", revision: error ? null : record?.revision ?? old?.revision ?? null,
      collectionRevision: collectionRevision(userId), createdAt: now, completedAt: now };
    if (requestId) db.prepare("INSERT INTO record_operations(user_id,request_id,request_hash,result_json) VALUES(?,?,?,?)").run(userId, requestId, hash, JSON.stringify(operation));
    return { operation, error, tracked: strict };
  }).immediate();
}
