import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { getCookie, getSessionToken } from "./auth";
import { hmacWithDataKey } from "./secretStorage";
import { clientIp, rateLimit } from "./rateLimit";
import { parsePasskeyConfig } from "./passkeyConfig";

export const PASSKEY_COOKIE = "fire_passkey_challenge";
export const PASSKEY_CLIENT_COOKIE = "fire_passkey_client";

/** Signed browser identity isolates clients without a reliable IP; trusted proxy IP is an additional budget.
 * Anonymous clients can clear cookies, so volumetric abuse still needs edge/proxy rate limiting.
 */
export function passkeyLoginClient(request: Request) {
  const raw = getCookie(request, PASSKEY_CLIENT_COOKIE) || "";
  const parts = raw.split(".");
  const payload = parts.slice(0, 2).join(".");
  if (parts.length === 3 && /^[a-f0-9]{48}$/.test(parts[0]) && /^\d{13}$/.test(parts[1]) && /^[a-f0-9]{64}$/.test(parts[2])) {
    const expires = Number(parts[1]);
    if (expires > Date.now() && expires <= Date.now() + 900000 && timingSafeEqual(Buffer.from(parts[2], "hex"), Buffer.from(hmacWithDataKey(`passkey-client:${payload}`), "hex"))) return { id: parts[0], cookie: raw };
  }
  const id = randomBytes(24).toString("hex");
  const next = `${id}.${Date.now() + 900000}`;
  return { id, cookie: `${next}.${hmacWithDataKey(`passkey-client:${next}`)}` };
}
export function allowPasskeyLoginOptions(request: Request, clientId: string) {
  const ip = clientIp(request);
  // Never put every deployment user into the same "direct" or "unknown" bucket.
  if (ip !== "direct" && ip !== "unknown" && !rateLimit(`passkey-options-ip:${ip}`, 100, 60000)) return false;
  return rateLimit(`passkey-options-browser:${clientId}`, 30, 900000);
}
export type PasskeyConfig = { enabled: boolean; origin: string; rpID: string; name: string; revision: string };
export type PasskeyRow = { id: string; user_id: string; user_handle: string; rp_id: string; public_key: Buffer; counter: number; transports: string; name: string; backed_up: number; created_at: number; last_used_at: number | null };
export type PasskeyChallenge = { id: string; binding: string; purpose: string; user_id: string | null; challenge: string; config_revision: string; password_hash: string; expires_at: number };
export function passkeyConfig(): PasskeyConfig {
  const row = getDb().prepare("SELECT value FROM passkey_config WHERE id=1").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { enabled: false, origin: "", rpID: "", name: "Fire", revision: "" };
}
export function normalizePasskeyConfig(value: { enabled?: unknown; origin?: unknown; name?: unknown }): PasskeyConfig {
  const fields = parsePasskeyConfig(value);
  return { ...fields, rpID: fields.origin ? new URL(fields.origin).hostname : "", revision: randomBytes(16).toString("hex") };
}
export class PasskeyConfigConflictError extends Error {
  constructor() { super("登录设置已在其他窗口更新，请刷新后确认再保存"); }
}
export function savePasskeyConfig(config: PasskeyConfig, expectedRevision?: string): PasskeyConfig {
  const db = getDb();
  return db.transaction(() => {
    const current = passkeyConfig();
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new PasskeyConfigConflictError();
    if (current.enabled === config.enabled && current.origin === config.origin && current.name === config.name) return current;
    db.prepare("INSERT INTO passkey_config(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
    db.prepare("DELETE FROM passkey_challenges").run();
    return config;
  }).immediate();
}
export function assertPasskeyOrigin(request: Request, config: PasskeyConfig) {
  if (!config.enabled) throw new Error("站点尚未启用通行密钥");
  if (request.headers.get("origin") !== config.origin) throw new Error("请通过站点配置的地址使用通行密钥");
}
export function listPasskeys(userId: string): PasskeyRow[] {
  return getDb().prepare("SELECT * FROM passkeys WHERE user_id=? ORDER BY created_at DESC").all(userId) as PasskeyRow[];
}
export function passkeyBinding(request: Request, purpose: string, nonce: string) {
  return createHash("sha256").update(`${purpose}:${nonce}:${purpose === "register" ? getSessionToken(request) || "" : ""}`).digest("hex");
}
export function issuePasskeyChallenge(request: Request, purpose: "register" | "login", challenge: string, config: PasskeyConfig, userId: string | null = null, passwordHash = "", browserId?: string) {
  const nonce = browserId || randomBytes(32).toString("base64url");
  const id = randomBytes(24).toString("hex");
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM passkey_challenges WHERE expires_at<=?").run(Date.now());
    if (browserId) db.prepare("DELETE FROM passkey_challenges WHERE purpose=? AND binding=?").run(purpose, passkeyBinding(request, purpose, nonce));
    db.prepare("INSERT INTO passkey_challenges(id,binding,purpose,user_id,challenge,config_revision,password_hash,expires_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, passkeyBinding(request, purpose, nonce), purpose, userId, challenge, config.revision, passwordHash, Date.now() + 300000);
  })();
  return { id, nonce };
}
export function consumePasskeyChallenge(request: Request, id: string, purpose: "register" | "login", config: PasskeyConfig, userId?: string): PasskeyChallenge {
  const nonce = getCookie(request, PASSKEY_COOKIE) || "";
  const row = getDb().prepare("DELETE FROM passkey_challenges WHERE id=? AND binding=? AND purpose=? AND config_revision=? AND expires_at>? RETURNING *")
    .get(id, passkeyBinding(request, purpose, nonce), purpose, config.revision, Date.now()) as PasskeyChallenge | undefined;
  if (!row || (userId && row.user_id !== userId)) throw new Error("验证已过期或已使用，请重新尝试");
  return row;
}
