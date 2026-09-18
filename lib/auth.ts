import { createHash, randomBytes } from "crypto";
import { getDb } from "./db";
import { hashPassword, verifyPassword } from "./password";
import type { User } from "./types";

export const SESSION_COOKIE = "fire_session";
export const LEGACY_SESSION_COOKIE = "sto" + "cklog_session";
const SESSION_DAYS = 7;
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(24).toString("hex"));

interface UserRow {
  id: string;
  username: string;
  nickname: string;
  uid: string;
  password_hash: string;
  email: string;
  avatar: string;
  role: string;
  created_at: string;
  is_test: number;
}

export function findUserByUsername(username: string): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

/** 支持用户名或邮箱登录：邮箱大小写不敏感，用户名精确匹配 */
export function findUserByLogin(login: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE username = ? OR LOWER(email) = LOWER(?)")
    .get(login, login) as UserRow | undefined;
}

/** 按邮箱（大小写不敏感）查用户，用于注册邮箱唯一校验 */
export function findUserByEmail(email: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE LOWER(email) = LOWER(?)")
    .get(email.trim().toLowerCase()) as UserRow | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** 恒定走一次 scrypt，减少用户名枚举时的响应时间差。管理员身份完全由数据库 role 决定，不绑定任何固定用户 ID。 */
export function authenticateUser(username: string, password: string): UserRow | null {
  const row = findUserByLogin(username);
  const valid = verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !valid) return null;
  return row;
}

function toUser(
  row: Pick<UserRow, "id" | "username" | "nickname" | "uid" | "email" | "avatar" | "role" | "is_test">
): User {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname ?? "",
    uid: row.uid ?? "",
    email: row.email ?? "",
    avatar: row.avatar ?? "",
    role: row.role === "admin" ? "admin" : "user",
    isTest: row.is_test === 1
  };
}

export function createUser(username: string, password: string, isTest = false, email = ""): User {
  const db = getDb();
  const id = "u-" + randomBytes(8).toString("hex");
  const hash = hashPassword(password);
  const now = new Date().toISOString();
  const normalizedEmail = email.trim().toLowerCase();
  let uid = "";
  if (isTest) {
    // 测试账号不占用 UID（uid 为 NULL），可多个并存
    db.prepare(
      "INSERT INTO users (id, username, password_hash, created_at, email, avatar, role, nickname, uid, is_test) VALUES (?, ?, ?, ?, '', '', 'user', '', NULL, 1)"
    ).run(id, username, hash, now);
    return { id, username, nickname: "", uid, email: "", avatar: "", role: "user", isTest: true };
  }
  // 首个非测试注册用户自动成为管理员，后续注册均为普通用户。
  // 测试账号不占位（is_test=1 不参与判断）；若 seed 已用 INITIAL_ADMIN_* 建过管理员，
  // 这里会因已有非测试用户而判定为普通用户。
  const isFirst = needsSetup();
  const role = isFirst ? "admin" : "user";
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = db.prepare("SELECT uid FROM users ORDER BY CAST(uid AS INTEGER) DESC LIMIT 1").get() as { uid: string } | undefined;
    const next = last && /^\d+$/.test(last.uid) ? String(parseInt(last.uid, 10) + 1) : "1";
    try {
      db.prepare(
        "INSERT INTO users (id, username, password_hash, created_at, email, avatar, role, nickname, uid) VALUES (?, ?, ?, ?, ?, '', ?, '', ?)"
      ).run(id, username, hash, now, normalizedEmail, role, next);
      uid = next;
      break;
    } catch {
      if (attempt === 4) throw new Error("UID 分配冲突，请重试");
    }
  }
  return { id, username, nickname: "", uid, email: "", avatar: "", role };
}

/** 没有任何非测试用户时，需要走首次管理员设置。 */
export function needsSetup(): boolean {
  return !getDb().prepare("SELECT 1 FROM users WHERE is_test = 0 LIMIT 1").get();
}

export function updatePassword(userId: string, newPassword: string): boolean {
  const result = getDb()
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(hashPassword(newPassword), userId);
  return result.changes > 0;
}

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  getDb().prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(sessionDbToken(token), userId, expiresAt);
  return token;
}

/** 数据库只保存会话令牌摘要，数据库或备份泄露时不能直接劫持在线会话。 */
function sessionDbToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getUserByToken(token: string | null): User | null {
  if (!token) return null;
  const db = getDb();
  const lookup = db.prepare(`
    SELECT s.expires_at, u.id, u.username, u.nickname, u.uid, u.email, u.avatar, u.role, u.is_test
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `);
  const digest = sessionDbToken(token);
  let row = lookup.get(digest) as { expires_at: number; id: string; username: string; nickname: string; uid: string; email: string; avatar: string; role: string; is_test: number } | undefined;
  // 兼容升级前的明文会话：首次使用即原地迁移为摘要，不强制用户重新登录。
  if (!row) {
    row = lookup.get(token) as typeof row;
    if (row) {
      try {
        db.prepare("UPDATE sessions SET token = ? WHERE token = ?").run(digest, token);
      } catch {
        return null;
      }
    }
  }
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token IN (?, ?)").run(digest, token);
    return null;
  }
  return toUser(row);
}

export function deleteSession(token: string | null) {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token IN (?, ?)").run(sessionDbToken(token), token);
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

export function getAuthUser(request: Request): User | null {
  // 兼容两种认证方式：Web 端 httpOnly Cookie 会话；移动端（Swift / Android）Authorization: Bearer <token>
  const cookieToken = getCookie(request, SESSION_COOKIE) || getCookie(request, LEGACY_SESSION_COOKIE);
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  // Bearer 是显式认证，优先于浏览器可能残留的过期 Cookie。
  if (bearer) return getUserByToken(bearer);
  if (cookieToken && !isTrustedMutationRequest(request)) return null;
  return getUserByToken(cookieToken || null);
}

/**
 * Cookie 认证的写请求必须来自同源页面，阻断跨站请求伪造。
 * 原生客户端使用 Bearer，不受 Origin 限制；curl 等无浏览器来源头的服务端调用继续兼容。
 */
export function isTrustedMutationRequest(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin) return fetchSite !== "cross-site";
  try {
    const originUrl = new URL(origin);
    const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
    return (originUrl.protocol === "http:" || originUrl.protocol === "https:") && originUrl.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export function isAdmin(user: User | null): boolean {
  return user?.role === "admin";
}

export function deleteOtherSessions(userId: string, keepToken: string | null) {
  const db = getDb();
  if (keepToken) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token NOT IN (?, ?)").run(userId, sessionDbToken(keepToken), keepToken);
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function sessionCookieMaxAge() {
  return SESSION_DAYS * 24 * 60 * 60;
}

export function applySessionCookie(res: { cookies: { set: (name: string, value: string, options: { httpOnly: boolean; sameSite: "lax"; path: string; maxAge: number; secure: boolean }) => void } }, token: string, request: Request) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionCookieMaxAge(),
    secure: sessionCookieSecure(request)
  });
  res.cookies.set(LEGACY_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0, sameSite: "lax", secure: false });
}

/** 判断当前请求是否通过 HTTPS 访问，用于决定 session cookie 是否带 Secure 标志。
 * 局域网 http://IP:port 部署时若带 Secure，浏览器不保存/不发送 cookie，登录后会无限跳回登录页。
 * 仅当反向代理转发 x-forwarded-proto: https 或原生 https 时才返回 true。 */
export function sessionCookieSecure(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  return proto === "https";
}

/* ---------- 个人资料与用户管理 ---------- */

export function updateProfile(
  userId: string,
  patch: { username?: string; email?: string; nickname?: string }
): User | null {
  const db = getDb();
  const row = findUserById(userId);
  if (!row) return null;
  const username = patch.username !== undefined ? patch.username.trim() : row.username;
  const email = patch.email !== undefined ? patch.email.trim() : (row.email ?? "");
  const nickname = patch.nickname !== undefined ? patch.nickname.trim() : (row.nickname ?? "");

  if (patch.username !== undefined) {
    const conflict = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(username, userId);
    if (conflict) return null;
  }
  db.prepare("UPDATE users SET username = ?, email = ?, nickname = ? WHERE id = ?").run(username, email, nickname, userId);
  const updated = findUserById(userId)!;
  return toUser(updated);
}

export function updateUserAvatar(userId: string, avatar: string) {
  getDb().prepare("UPDATE users SET avatar = ? WHERE id = ?").run(avatar, userId);
}

export interface AdminUser extends User {
  createdAt: string;
  recordsCount: number;
  online: boolean;
  totpEnabled: boolean;
}

export function listUsers(): AdminUser[] {
  const now = Date.now();
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.nickname, u.uid, u.email, u.avatar, u.role, u.created_at, u.is_test, u.totp_enabled,
      (SELECT COUNT(*) FROM records r WHERE r.user_id = u.id) AS records_count,
      EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS online
    FROM users u
    ORDER BY (u.uid IS NULL OR u.uid = '') ASC, CAST(u.uid AS INTEGER) ASC
  `).all(now) as (UserRow & { records_count: number; online: number })[];
  return rows.map((r) => ({
    ...toUser(r),
    createdAt: r.created_at,
    recordsCount: r.records_count,
    online: !!r.online,
    totpEnabled: Boolean((r as UserRow & { totp_enabled?: number }).totp_enabled)
  }));
}

export function updateUserById(
  userId: string,
  patch: { username?: string; email?: string; role?: string }
): User | null {
  const db = getDb();
  const row = findUserById(userId);
  if (!row) return null;
  const username = patch.username !== undefined ? patch.username.trim() : row.username;
  const email = patch.email !== undefined ? patch.email.trim() : (row.email ?? "");
  const role = patch.role === "admin" || patch.role === "user" ? patch.role : row.role;

  if (row.role === "admin" && role === "user") {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    if (admins.n <= 1) return null;
  }

  if (patch.username !== undefined) {
    const conflict = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(username, userId);
    if (conflict) return null;
  }
  db.prepare("UPDATE users SET username = ?, email = ?, role = ? WHERE id = ?").run(username, email, role, userId);
  return toUser(findUserById(userId)!);
}

export function deleteUserById(userId: string): boolean {
  const db = getDb();
  const row = findUserById(userId);
  if (!row) return false;
  if (row.role === "admin") {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    if (admins.n <= 1) return false;
  }
  return db.prepare("DELETE FROM users WHERE id = ?").run(userId).changes > 0;
}

export function resetUserPassword(userId: string, newPassword: string): boolean {
  return updatePassword(userId, newPassword);
}
