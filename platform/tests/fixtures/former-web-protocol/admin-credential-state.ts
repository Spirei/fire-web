export type RecoveryAction = "reset-password" | "disable-totp";
export type RecoveryTarget = {
  id: string;
  username: string;
  revision: string;
  two_factor_enabled?: boolean;
};
export type RecoverySecrets = {
  currentPassword: string;
  code: string;
  newPassword: string;
  confirmation: string;
};
export type RecoveryReceipt = {
  request_id: string;
  action: RecoveryAction;
  target_id: string;
  revision: string;
  ok: true;
  totpDisabled: true;
  passkeysRevoked: boolean;
};
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function recoveryCommand(
  action: RecoveryAction,
  target: RecoveryTarget,
  secrets: RecoverySecrets,
  id: string,
) {
  if (!uuid(id) || !uuid(target.revision) || !target.id)
    throw Error("账号版本或操作编号待核对");
  if (!["reset-password", "disable-totp"].includes(action))
    throw Error("请选择恢复操作");
  if (!secrets.currentPassword) throw Error("请输入当前管理员密码");
  if (
    Array.from(secrets.currentPassword).length > 128 ||
    secrets.code.length > 64
  )
    throw Error("管理员密码或验证码过长");
  if (action === "disable-totp" && target.two_factor_enabled !== true)
    throw Error("该账号的双重验证状态尚未核实为已启用");
  if (action === "reset-password") {
    if (secrets.newPassword !== secrets.confirmation)
      throw Error("两次新密码不一致");
    if (
      Array.from(secrets.newPassword).length < 8 ||
      Array.from(secrets.newPassword).length > 128
    )
      throw Error("新密码长度应为8至128个字符");
  }
  return {
    request_id: id,
    revision: target.revision,
    current_password: secrets.currentPassword,
    code: secrets.code,
    ...(action === "reset-password"
      ? { new_password: secrets.newPassword }
      : {}),
  };
}
export function recoveryReceipt(
  raw: unknown,
  id: string,
  target?: string,
  expected?: { action: RecoveryAction; revision: string },
): RecoveryReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("账号恢复回执待核对");
  const v = raw as Record<string, unknown>;
  if (
    !uuid(id) ||
    v.request_id !== id ||
    !["reset-password", "disable-totp"].includes(String(v.action)) ||
    v.passkeysRevoked !== (v.action === "reset-password") ||
    typeof v.target_id !== "string" ||
    !v.target_id ||
    (target !== undefined && v.target_id !== target) ||
    !uuid(v.revision) ||
    v.ok !== true ||
    v.totpDisabled !== true ||
    typeof v.passkeysRevoked !== "boolean"
  )
    throw Error("账号恢复回执与原操作不符");
  if (
    expected &&
    (v.action !== expected.action || v.revision === expected.revision)
  )
    throw Error("账号恢复结果与原操作类型或版本不符");
  return v as unknown as RecoveryReceipt;
}
export function recoveryLabel(receipt: RecoveryReceipt) {
  return receipt.action === "reset-password"
    ? "密码已重置，双重验证和通行密钥已撤销"
    : "双重验证已停用";
}
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function retainRecoveryId(s: Store, key: string, id: string) {
  if (!uuid(id)) throw Error("操作编号无效");
  const old = s.getItem(key);
  if (old && old !== id) throw Error("请先核对原账号操作");
  s.setItem(key, id);
}
export function releaseRecoveryId(s: Store, key: string, id: string) {
  if (s.getItem(key) === id) s.removeItem(key);
}

export type RemovalReceipt = {
  request_id: string;
  user_id: string;
  deleted: true;
};
export function removalReceipt(
  raw: unknown,
  id: string,
  target?: string,
): RemovalReceipt {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("删除回执待核对");
  const value = raw as Record<string, unknown>;
  if (
    !uuid(id) ||
    value.request_id !== id ||
    value.deleted !== true ||
    typeof value.user_id !== "string" ||
    !value.user_id ||
    (target !== undefined && value.user_id !== target)
  )
    throw Error("删除回执与原操作不符");
  return value as RemovalReceipt;
}
