import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { getDb } from "./db";
import { getCookie, getSessionToken } from "./auth";

export const PASSKEY_COOKIE = "fire_passkey_challenge";
export type PasskeyConfig = { enabled: boolean; origin: string; rpID: string; name: string; revision: string };
export type PasskeyRow = { id: string; user_id: string; user_handle: string; rp_id: string; public_key: Buffer; counter: number; transports: string; name: string; backed_up: number; created_at: number; last_used_at: number | null };
export type PasskeyChallenge = { id: string; binding: string; purpose: string; user_id: string | null; challenge: string; config_revision: string; password_hash: string; expires_at: number };
export function passkeyConfig(): PasskeyConfig {
  const row = getDb().prepare("SELECT value FROM passkey_config WHERE id=1").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { enabled: false, origin: "", rpID: "", name: "Fire", revision: "" };
}
export function normalizePasskeyConfig(value: { enabled?: unknown; origin?: unknown; name?: unknown }): PasskeyConfig {
  if (typeof value.enabled !== "boolean") throw new Error("请选择是否启用通行密钥");
  const name = String(value.name ?? "Fire").trim();
  const raw = String(value.origin ?? "").trim();
  if (!name || name.length > 64) throw new Error("站点名称需为 1–64 个字符");
  let origin = "", rpID = "";
  if (raw) {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || isIP(url.hostname) || url.hostname.includes(":")) {
      throw new Error("请填写完整 HTTPS 站点地址，不包含路径、参数或 IP 地址（本地测试可用 http://localhost:3000）");
    }
    origin = url.origin; rpID = url.hostname;
  }
  if (value.enabled && !origin) throw new Error("启用前请填写 HTTPS 站点地址");
  return { enabled: value.enabled, origin, rpID, name, revision: randomBytes(16).toString("hex") };
}
export function savePasskeyConfig(config: PasskeyConfig) {
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO passkey_config(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
    db.prepare("DELETE FROM passkey_challenges").run();
  })();
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
export function issuePasskeyChallenge(request: Request, purpose: "register" | "login", challenge: string, config: PasskeyConfig, userId: string | null = null, passwordHash = "") {
  const nonce = randomBytes(32).toString("base64url");
  const id = randomBytes(24).toString("hex");
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM passkey_challenges WHERE expires_at<=?").run(Date.now());
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
