import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { getSiteSettings } from "./settings";
import { publicSiteDomain } from "./publicSiteUrl";
import { DEFAULT_APP_DEVICE_NAME, normalizeAppDeviceName } from "./brand";

export const APP_CLIENT_ID = "fire-ios";
export const APP_REDIRECT_URI = "com.fire.app:/oauth/callback";
export const APP_SCOPE = "portfolio.read portfolio.write";
const ACCESS_SECONDS = 15 * 60;
const REFRESH_IDLE_MS = 30 * 86400_000;
const REFRESH_MAX_MS = 90 * 86400_000;
export const appTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const opaque = (prefix: string) => prefix + randomBytes(32).toString("base64url");

export interface AppAuthorization {
  client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string;
  response_type: string; scope: string; state: string; device_name: string;
}
export function parseAppAuthorization(values: Record<string, unknown>): AppAuthorization {
  const value = (key: string) => typeof values[key] === "string" ? values[key] as string : "";
  const scope = value("scope").split(" ").filter(Boolean);
  if (value("client_id") !== APP_CLIENT_ID || value("redirect_uri") !== APP_REDIRECT_URI || value("response_type") !== "code") throw new Error("不支持的 App 或回调地址");
  if (value("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(value("code_challenge"))) throw new Error("无效的授权校验参数");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value("state"))) throw new Error("无效的授权请求");
  if (!scope.includes("portfolio.read") || scope.some(s => !APP_SCOPE.split(" ").includes(s))) throw new Error("不支持的授权范围");
  const deviceName = value("device_name").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 64);
  return { client_id: APP_CLIENT_ID, redirect_uri: APP_REDIRECT_URI, response_type: "code", code_challenge_method: "S256", code_challenge: value("code_challenge"), scope: [...new Set(scope)].join(" "), state: value("state"), device_name: normalizeAppDeviceName(deviceName) || DEFAULT_APP_DEVICE_NAME };
}

/** Production accepts only the configured public HTTPS origin; no request Host discovery. */
export function assertAppOrigin(request: Request) {
  const configured = publicSiteDomain(process.env.FIRE_APP_ORIGIN || getSiteSettings().domain);
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") || url.host;
  const requestHost = new URL(`${url.protocol}//${host}`).hostname;
  if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(requestHost) && (!origin || origin === `${url.protocol}//${host}`)) return;
  if (!configured || host.toLowerCase() !== new URL(configured).host.toLowerCase() || (origin && origin !== configured) || (url.protocol !== "https:" && request.headers.get("x-forwarded-proto") !== "https")) throw new Error("请通过已配置的 Alcor HTTPS 域名连接");
}

type SecurityUser = { password_hash: string; totp_secret: string; totp_enabled: number };
function securityStamp(user: SecurityUser) { return appTokenHash(`${user.password_hash}:${user.totp_enabled}:${user.totp_secret}`); }
interface Grant extends SecurityUser {
  id: string; user_id: string; scope: string; passkey_id: string | null; security_stamp: string;
  device_name: string; last_used_at: number; created_at: number; expires_at: number; revoked_at: number | null;
  username: string; nickname: string; uid: string; email: string; avatar: string; is_test: number;
}
function activeGrant(id: string): Grant | null {
  const row = getDb().prepare(`SELECT g.*, u.password_hash, u.totp_secret, u.totp_enabled,
    u.username,u.nickname,u.uid,u.email,u.avatar,u.is_test FROM app_grants g JOIN users u ON u.id=g.user_id WHERE g.id=?`).get(id) as Grant | undefined;
  const now = Date.now();
  if (!row || row.revoked_at !== null || row.expires_at <= now || row.created_at + REFRESH_MAX_MS <= now) return null;
  if (row.security_stamp !== securityStamp(row) || (row.passkey_id && !getDb().prepare("SELECT 1 FROM passkeys WHERE id=? AND user_id=?").get(row.passkey_id, row.user_id))) {
    revokeAppGrant(row.id); return null;
  }
  return row;
}
export function issueAppCode(auth: AppAuthorization, userId: string, browserToken: string): string {
  const db = getDb();
  return db.transaction(() => {
    const sessionHash = appTokenHash(browserToken);
    if (!db.prepare("SELECT 1 FROM sessions WHERE token=? AND user_id=? AND expires_at>?").get(sessionHash, userId, Date.now())) throw new Error("登录已失效，请重新登录");
    db.prepare("DELETE FROM app_codes WHERE expires_at<=?").run(Date.now());
    const code = opaque("fac_");
    db.prepare(`INSERT INTO app_codes(code_hash,user_id,session_hash,client_id,redirect_uri,challenge,scope,device_name,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(appTokenHash(code), userId, sessionHash, auth.client_id, auth.redirect_uri, auth.code_challenge, auth.scope, auth.device_name, Date.now() + 60_000);
    return code;
  }).immediate();
}
function issueTokens(grantId: string) {
  const db = getDb();
  const access = opaque("fat_"); const refresh = opaque("frt_");
  db.prepare("DELETE FROM app_access_tokens WHERE expires_at<=?").run(Date.now());
  // Used refresh hashes live until the grant expires so reuse remains detectable.
  db.prepare("DELETE FROM app_grants WHERE expires_at<=? OR created_at<=?").run(Date.now(), Date.now() - REFRESH_MAX_MS);
  db.prepare("INSERT INTO app_access_tokens VALUES(?,?,?)").run(appTokenHash(access), grantId, Date.now() + ACCESS_SECONDS * 1000);
  db.prepare("INSERT INTO app_refresh_tokens(token_hash,grant_id) VALUES(?,?)").run(appTokenHash(refresh), grantId);
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_SECONDS, grant_id: grantId };
}
export function exchangeAppCode(values: Record<string, unknown>) {
  if (values.client_id !== APP_CLIENT_ID || values.redirect_uri !== APP_REDIRECT_URI || typeof values.code !== "string" || !/^fac_[A-Za-z0-9_-]{43}$/.test(values.code) || typeof values.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(values.code_verifier)) return null;
  const db = getDb();
  return db.transaction(() => {
    const code = db.prepare("SELECT * FROM app_codes WHERE code_hash=?").get(appTokenHash(values.code as string)) as { user_id: string; session_hash: string; challenge: string; scope: string; device_name: string; expires_at: number } | undefined;
    if (!code || code.expires_at <= Date.now()) return null;
    const challenge = createHash("sha256").update(values.code_verifier as string).digest("base64url");
    if (!timingSafeEqual(Buffer.from(challenge), Buffer.from(code.challenge))) return null;
    db.prepare("DELETE FROM app_codes WHERE code_hash=?").run(appTokenHash(values.code as string));
    const session = db.prepare("SELECT passkey_id FROM sessions WHERE token=? AND user_id=? AND expires_at>?").get(code.session_hash, code.user_id, Date.now()) as { passkey_id: string | null } | undefined;
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(code.user_id) as SecurityUser | undefined;
    if (!session || !user) return null;
    const id = opaque("fg_"); const now = Date.now();
    // Keep the device list bounded; old grants and their token families are removed together.
    const old = db.prepare("SELECT id FROM app_grants WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 19").all(code.user_id) as { id: string }[];
    for (const grant of old) db.prepare("DELETE FROM app_grants WHERE id=?").run(grant.id);
    db.prepare(`INSERT INTO app_grants(id,user_id,client_id,scope,device_name,security_stamp,passkey_id,created_at,last_used_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, code.user_id, APP_CLIENT_ID, code.scope, code.device_name, securityStamp(user), session.passkey_id, now, now, now + REFRESH_IDLE_MS);
    return { ...issueTokens(id), scope: code.scope };
  }).immediate();
}
export function refreshAppTokens(clientId: unknown, token: unknown) {
  if (clientId !== APP_CLIENT_ID || typeof token !== "string" || !/^frt_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM app_refresh_tokens WHERE token_hash=?").get(appTokenHash(token)) as { grant_id: string; used_at: number | null } | undefined;
    if (!row) return null;
    if (row.used_at !== null) { revokeAppGrant(row.grant_id); return null; }
    const grant = activeGrant(row.grant_id);
    if (!grant) return null;
    const now = Date.now();
    db.prepare("UPDATE app_refresh_tokens SET used_at=? WHERE token_hash=?").run(now, appTokenHash(token));
    db.prepare("UPDATE app_grants SET last_used_at=?,expires_at=? WHERE id=?").run(now, Math.min(now + REFRESH_IDLE_MS, grant.created_at + REFRESH_MAX_MS), grant.id);
    return { ...issueTokens(grant.id), scope: grant.scope };
  }).immediate();
}
export function revokeAppGrant(id: string, userId?: string) {
  getDb().prepare(`UPDATE app_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?${userId ? " AND user_id=?" : ""}`).run(...(userId ? [Date.now(), id, userId] : [Date.now(), id]));
}
export function revokeAppToken(token: string) {
  const table = token.startsWith("fat_") ? "app_access_tokens" : "app_refresh_tokens";
  const row = getDb().prepare(`SELECT grant_id FROM ${table} WHERE token_hash=?`).get(appTokenHash(token)) as { grant_id: string } | undefined;
  if (row) revokeAppGrant(row.grant_id);
}
export function revokeUserAppGrants(userId: string) {
  getDb().prepare("UPDATE app_grants SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?").run(Date.now(), userId);
  getDb().prepare("DELETE FROM app_codes WHERE user_id=?").run(userId);
}

/** Explicit resource/method allowlist; App grants never confer site administrator privileges. */
export function appIdentity(token: string, request: Request): Grant | null {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  const read = method === "GET" && /^\/api\/v1\/(?:auth\/me|overview|records(?:\/[^/]+)?|watch-groups|brokers|assets|celebs|rates|orders(?:\/[^/]+)?|funds|fire-settings|simple-ledger|portfolio-series)$/.test(path);
  const marketRead = ["GET", "POST"].includes(method) && /^\/api\/v1\/(?:quotes|charts|kline|index-kline|kline-sessions|stock-detail|search|earnings)$/.test(path);
  const write = ["POST", "PUT", "DELETE"].includes(method) && /^\/api\/v1\/(?:records(?:\/[^/]+)?|watch-groups(?:\/[^/]+(?:\/icon)?)?|orders(?:\/[^/]+)?|funds(?:\/[^/]+)?|fire-settings|simple-ledger)$/.test(path);
  if (!read && !marketRead && !write) return null;
  try { assertAppOrigin(request); } catch { return null; }
  const row = getDb().prepare("SELECT grant_id FROM app_access_tokens WHERE token_hash=? AND expires_at>?").get(appTokenHash(token), Date.now()) as { grant_id: string } | undefined;
  const grant = row && activeGrant(row.grant_id);
  if (!grant || (write && !grant.scope.split(" ").includes("portfolio.write"))) return null;
  return grant;
}
export function listAppDevices(userId: string) {
  const rows = getDb().prepare("SELECT id FROM app_grants WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC").all(userId) as { id: string }[];
  return rows.map(row => activeGrant(row.id)).filter((g): g is Grant => !!g).map(g => ({ id: g.id, name: normalizeAppDeviceName(g.device_name), scope: g.scope, createdAt: g.created_at, lastUsedAt: g.last_used_at, expiresAt: g.expires_at }));
}
