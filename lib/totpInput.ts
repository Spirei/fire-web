/** 登录 / 绑定时的 6 位验证码输入：只保留数字，最多 6 位。 */
export function normalizeTotpDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function isSixDigitTotp(value: string): boolean {
  return /^\d{6}$/.test(value.replace(/\s/g, ""));
}

/** 备用码输入：小写十六进制与连字符，最多 19 位（xxxx-xxxx-xxxx-xxxx）。 */
export function normalizeBackupInput(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-f0-9-]/g, "").slice(0, 19);
}

export function isCompleteBackupCode(value: string): boolean {
  return value.replace(/[^a-f0-9]/gi, "").length >= 8;
}
