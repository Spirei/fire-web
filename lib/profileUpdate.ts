import { findUserByEmail, findUserById, getAuthUser, updateProfile } from "./auth";
import { getDb } from "./db";
import { verifyPassword } from "./password";
import { readJsonBody } from "./requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "./rateLimit";
import { logSecurityEvent } from "./securityAudit";
import { consumeTotpFactor, userTotpEnabled } from "./totpAuth";
import type { User } from "./types";

export class ProfileError extends Error {
  constructor(message: string, public status = 400, public code = status * 100 + 1) { super(message); }
}

/** Web and App edit the same row, with identical validation and email verification rules. */
export async function saveProfile(request: Request, strict = false, emailOnly = false) {
  const user = getAuthUser(request);
  if (!user) throw new ProfileError("未登录或连接缺少资料编辑权限", 401);
  if (!rateLimit(`profile:${clientIp(request)}:${user.id}`, 30, 3600_000) || !rateLimit(`profile:account:${user.id}`, 30, 3600_000) || !rateLimitGlobal("profile", 300, 3600_000)) throw new ProfileError("操作过于频繁，请稍后再试", 429);
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProfileError("无效的请求体");
  if (strict && Object.keys(body).some(key => !(emailOnly ? ["email", "currentPassword", "code"] : ["username", "nickname", "email", "currentPassword", "code"]).includes(key))) throw new ProfileError("包含不支持修改的字段");
  if (emailOnly && typeof body.email !== "string") throw new ProfileError("请填写邮箱");
  if (strict && body.code !== undefined && (typeof body.code !== "string" || body.code.length > 64)) throw new ProfileError("验证码格式不正确");
  const patch: { username?: string; email?: string; nickname?: string } = {};
  for (const key of ["username", "nickname", "email"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") throw new ProfileError("资料字段必须为文字");
    patch[key] = body[key].trim();
  }
  if (patch.username !== undefined && (patch.username.length < 3 || patch.username.length > 20 || !/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(patch.username))) throw new ProfileError("用户名需为 3-20 位字母、数字、下划线或中文");
  if (patch.nickname !== undefined && patch.nickname.length > 20) throw new ProfileError("昵称最多 20 个字符");
  if (patch.email !== undefined && (patch.email.length > 254 || (patch.email !== "" && !/^\S+@\S+\.\S+$/.test(patch.email)))) throw new ProfileError("邮箱格式不正确");
  if (strict && !Object.keys(patch).length) throw new ProfileError("请选择要修改的资料");
  // Reauthenticate after asynchronous body reads, under the write lock. Revoked connections
  // and concurrent credential/profile changes cannot pass a stale preflight check.
  const transaction = getDb().transaction(() => {
    const current = getAuthUser(request);
    const row = current && findUserById(current.id);
    if (!current || !row || current.id !== user.id) throw new ProfileError("登录或连接已失效", 401);
    if (patch.email !== undefined) {
      const changed = patch.email.toLowerCase() !== (row.email || "").trim().toLowerCase();
      if (emailOnly || changed) {
        if (typeof body.currentPassword !== "string" || body.currentPassword.length > 512 || !verifyPassword(body.currentPassword, row.password_hash)) throw new ProfileError("修改邮箱需要验证当前密码", 403, 40103);
      }
      const existing = patch.email && findUserByEmail(patch.email);
      if (existing && existing.id !== user.id) throw new ProfileError("该邮箱已被其他账号绑定", 409);
      // Recovery email can reset a password. App profile must not become a
      // second route around the dedicated email endpoint's second factor.
      if (strict && (emailOnly || changed) && userTotpEnabled(user.id) && !consumeTotpFactor(user.id, body.code || "")) throw new ProfileError("二次验证失败", 403, 40104);
    }
    const next = updateProfile(user.id, patch);
    if (!next) throw new ProfileError("用户名已被使用", 409);
    // A native grant does not inherit the account's site-administrator role.
    return { ...next, role: current.role };
  });
  let updated: User;
  try { updated = transaction.immediate(); }
  catch (error) {
    if (error instanceof ProfileError && error.status === 403) logSecurityEvent(request, user.id, "profile_email_rejected", "credential verification failed");
    throw error;
  }
  logSecurityEvent(request, user.id, "profile_update", patch.email !== undefined ? "profile and email" : "profile");
  return updated;
}
