import { recoveryReceipt, removalReceipt } from "./admin-credential-state.ts";

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export function closedAccountReceipt(raw: unknown, id: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("原账号操作关闭回执待核对");
  const value = raw as Record<string, unknown>;
  if (
    !uuid(id) ||
    value.request_id !== id ||
    value.closed !== true ||
    value.executed !== false
  )
    throw Error("原账号操作关闭回执与原编号不符");
  return { request_id: id, closed: true as const, executed: false as const };
}
export function accountOutcome(raw: unknown, id: string): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("账号操作回执待核对");
  const value = raw as Record<string, unknown>;
  if ("closed" in value) {
    closedAccountReceipt(value, id);
    return "已关闭，未执行";
  }
  if ("target_id" in value || "ok" in value) {
    const result = recoveryReceipt(value, id);
    return result.action === "reset-password" ? "密码已重置" : "双重验证已停用";
  }
  if ("deleted" in value) {
    removalReceipt(value, id);
    return "账号已删除";
  }
  const user = value.user as Record<string, unknown> | undefined;
  if (
    !uuid(id) ||
    value.request_id !== id ||
    typeof value.changed !== "boolean" ||
    !user ||
    typeof user.id !== "string" ||
    !user.id ||
    !uuid(user.revision)
  )
    throw Error("账号操作回执与原编号不符");
  return value.changed ? "账号已更新" : "账号无需变更";
}
export type AccountActionHistory = {
  items: { request_id: string; created_at: string; result: unknown }[];
  next_after: string | null;
};
export function accountActionHistory(raw: unknown): AccountActionHistory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("账号操作记录待核对");
  const value = raw as AccountActionHistory;
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    (value.next_after !== null && !uuid(value.next_after))
  )
    throw Error("账号操作分页待核对");
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !item ||
      !uuid(item.request_id) ||
      seen.has(item.request_id) ||
      typeof item.created_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT/.test(item.created_at) ||
      !Number.isFinite(Date.parse(item.created_at))
    )
      throw Error("账号操作记录待核对");
    accountOutcome(item.result, item.request_id);
    seen.add(item.request_id);
  }
  if (
    value.next_after !== null &&
    value.next_after !== value.items.at(-1)?.request_id
  )
    throw Error("账号操作分页标记待核对");
  return value;
}
