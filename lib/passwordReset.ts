import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";

const RESET_TTL_MS = 15 * 60 * 1000;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function issuePasswordResetToken(userId: string) {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + RESET_TTL_MS;
  db.transaction(() => {
    db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR user_id = ?").run(now, userId);
    db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash(token), userId, expiresAt, now);
  })();
  return { token, expiresAt };
}

export function revokePasswordResetToken(token: string) {
  if (!token) return;
  getDb().prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash(token));
}

/** 单次消费令牌并更新密码；校验与删除在同一事务中，避免并发复用。 */
export function consumePasswordResetToken(token: string, update: (userId: string) => void): string | null {
  if (!token || token.length > 256) return null;
  const db = getDb();
  const digest = tokenHash(token);
  return db.transaction(() => {
    const now = Date.now();
    const row = db.prepare("SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?")
      .get(digest) as { user_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= now) {
      db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ? OR expires_at <= ?").run(digest, now);
      return null;
    }
    update(row.user_id);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(row.user_id);
    return row.user_id;
  }).immediate();
}

export const PASSWORD_RESET_MINUTES = RESET_TTL_MS / 60_000;
