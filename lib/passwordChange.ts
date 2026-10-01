import { deleteOtherSessions, findUserById, getAuthUser, getSessionToken, updatePassword } from "./auth";
import { getDb } from "./db";
import { validatePassword, verifyPassword } from "./password";
import { clientIp, rateLimit, rateLimitGlobal } from "./rateLimit";
import { readJsonBody } from "./requestBody";
import { logSecurityEvent } from "./securityAudit";
import { consumeTotpFactor, userTotpEnabled } from "./totpAuth";

export class PasswordChangeError extends Error {
  constructor(message: string, public status = 400, public code = status * 100 + 1) { super(message); }
}

/** Shared Web/App credential validation; all effects commit or roll back together. */
export async function changeOwnPassword(request: Request, app = false) {
  const user = getAuthUser(request);
  if (!user) throw new PasswordChangeError("登录或连接已失效", 401);
  if (!rateLimit(`pwd:${clientIp(request)}:${user.id}`, 20, 15 * 60_000) || !rateLimit(`pwd:account:${user.id}`, 20, 15 * 60_000) || !rateLimitGlobal("pwd", 100, 15 * 60_000)) throw new PasswordChangeError("尝试过于频繁，请稍后再试", 429);
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PasswordChangeError("无效的请求体");
  if (app && Object.keys(body).some(key => !["currentPassword", "newPassword", "code"].includes(key))) throw new PasswordChangeError("包含不支持修改的字段");
  const oldPassword = app ? body.currentPassword : body.oldPassword;
  if (typeof oldPassword !== "string" || oldPassword.length > 128 || typeof body.newPassword !== "string" || (body.code !== undefined && (typeof body.code !== "string" || body.code.length > 64)) || (!app && body.signOutOthers !== undefined && typeof body.signOutOthers !== "boolean")) throw new PasswordChangeError("密码或验证码格式不正确");
  const passwordError = validatePassword(body.newPassword);
  if (passwordError) throw new PasswordChangeError(passwordError);
  const signedOutOthers = app || body.signOutOthers !== false;
  // v1 returns success once, then requires a fresh login/authorization. Never
  // silently reissue a grant or upgrade its scope after a credential change.
  const keepToken = app ? null : getSessionToken(request);
  let updated;
  try {
    updated = getDb().transaction(() => {
      const current = getAuthUser(request);
      const row = current && findUserById(current.id);
      if (!current || !row || current.id !== user.id) throw new PasswordChangeError("登录或连接已失效", 401);
      if (!verifyPassword(oldPassword, row.password_hash)) throw new PasswordChangeError("原密码错误", app ? 403 : 400, 40103);
      if (userTotpEnabled(user.id) && !consumeTotpFactor(user.id, body.code || "")) throw new PasswordChangeError("二次验证失败", app ? 403 : 400, 40104);
      if (!updatePassword(user.id, body.newPassword)) throw new Error("Account unavailable");
      if (signedOutOthers) deleteOtherSessions(user.id, keepToken);
      return current;
    }).immediate();
  } catch (error) {
    if (error instanceof PasswordChangeError && [40103, 40104].includes(error.code)) logSecurityEvent(request, user.id, "password_change_rejected", error.code === 40104 ? "totp mismatch" : "old password mismatch");
    throw error;
  }
  logSecurityEvent(request, user.id, "password_change", `password verified; ${signedOutOthers ? "other sessions revoked" : "other sessions preserved"}; app grants revoked`);
  return { ok: true, signedOutOthers, reauthenticationRequired: app, user: updated };
}
