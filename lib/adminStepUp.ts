import { findUserById } from "./auth";
import { verifyPassword } from "./password";
import { consumeTotpFactor, userTotpEnabled } from "./totpAuth";

export type AdminStepUpResult =
  | { ok: true }
  | { ok: false; error: string };

/** 高风险管理员操作必须重新验证密码；已启用 2FA 时还必须消费一次动态码或备用码。 */
export function verifyAdminStepUp(
  adminId: string,
  body: { currentPassword?: unknown; code?: unknown } | null | undefined
): AdminStepUpResult {
  const admin = findUserById(adminId);
  if (!admin || !verifyPassword(String(body?.currentPassword ?? ""), admin.password_hash)) {
    return { ok: false, error: "管理员密码不正确" };
  }
  if (userTotpEnabled(adminId) && !consumeTotpFactor(adminId, String(body?.code ?? ""))) {
    return { ok: false, error: "管理员二次验证失败" };
  }
  return { ok: true };
}
