import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { consumeTotpFactor, readTotpSecret, userTotpEnabled } from "./totpAuth";
import { emailVerified } from "./emailVerification";

const RESET_TTL_MS = 5 * 60 * 1000;
export const PASSWORD_RESET_COOLDOWN_SECONDS = 60;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function issuePasswordResetToken(userId: string, method: "email" | "totp" = "email") {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + RESET_TTL_MS;
  db.transaction(() => {
    const user = db.prepare("SELECT password_hash, email, totp_secret FROM users WHERE id = ?").get(userId) as { password_hash: string; email: string; totp_secret: string } | undefined;
    if (!user) throw new Error("Account unavailable");
    db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR user_id = ?").run(now, userId);
    db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at, password_hash, email, method, factor_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(tokenHash(token), userId, expiresAt, now, user.password_hash, user.email, method, method === "totp" ? tokenHash(user.totp_secret) : "");
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
    const row = db.prepare("SELECT t.user_id, t.expires_at, t.attempts, t.method, t.factor_hash, u.totp_secret, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.password_hash = u.password_hash AND t.email = u.email")
      .get(digest) as { user_id: string; expires_at: number; attempts: number; method: string; factor_hash: string; totp_secret: string; email: string } | undefined;
    if (!row || row.expires_at <= now || row.attempts >= 5) {
      db.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ? OR expires_at <= ?").run(digest, now);
      return null;
    }
    if (row.method === "email" ? !emailVerified(row.user_id, row.email) : row.method !== "totp" || !userTotpEnabled(row.user_id) || row.factor_hash !== tokenHash(row.totp_secret)) return null;
    update(row.user_id);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(row.user_id);
    db.prepare("DELETE FROM password_reset_codes WHERE user_id = ?").run(row.user_id);
    db.prepare("DELETE FROM password_reset_totp WHERE user_id = ?").run(row.user_id);
    return row.user_id;
  }).immediate();
}

export const PASSWORD_RESET_MINUTES = RESET_TTL_MS / 60_000;

export function newResetChallenge() { return randomBytes(32).toString("base64url"); }

export function retainedResetChallenge(userId: string, supplied: unknown) {
  if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return null;
  return getDb().prepare("SELECT 1 FROM password_reset_codes WHERE user_id = ? AND challenge_hash = ?").get(userId, tokenHash(supplied)) ? supplied : null;
}

/** 每账号持久冷却；只保存 challenge 和 code 的组合摘要，不保存验证码明文。 */
export function issuePasswordResetCode(userId: string, beforeIssue?: (email: string) => void) {
  const db = getDb();
  return db.transaction(() => {
    const now = Date.now();
    const previous = db.prepare("SELECT created_at FROM password_reset_codes WHERE user_id = ?").get(userId) as { created_at: number } | undefined;
    if (previous && now - previous.created_at < PASSWORD_RESET_COOLDOWN_SECONDS * 1000) return null;
    const user = db.prepare("SELECT password_hash, email FROM users WHERE id = ?").get(userId) as { password_hash: string; email: string } | undefined;
    if (!user?.email || !emailVerified(userId,user.email)) return null;
    beforeIssue?.(user.email); // Quota denial rolls back without replacing an existing valid code/grant.
    const challenge = newResetChallenge();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?").run(userId, now);
    db.prepare("DELETE FROM password_reset_codes WHERE expires_at <= ? AND created_at <= ?").run(now, now - 60_000);
    db.prepare("INSERT OR REPLACE INTO password_reset_codes (user_id, challenge_hash, code_hash, password_hash, email, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .run(userId, tokenHash(challenge), tokenHash(`${challenge}:${code}`), user.password_hash, user.email, now + RESET_TTL_MS, now);
    return { challenge, code, email: user.email };
  }).immediate();
}

export function revokePasswordResetCode(challenge: string) {
  // 保留发送冷却，即使 SMTP 失败也不能无限请求。
  getDb().prepare("UPDATE password_reset_codes SET code_hash = '', expires_at = 0 WHERE challenge_hash = ?").run(tokenHash(challenge));
}

export function verifyPasswordResetCode(challenge: string, code: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare("SELECT c.* FROM password_reset_codes c JOIN users u ON u.id = c.user_id WHERE c.challenge_hash = ? AND c.password_hash = u.password_hash AND c.email = u.email")
      .get(tokenHash(challenge)) as { user_id: string; code_hash: string; attempts: number; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now() || row.attempts >= 5) return null;
    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(tokenHash(`${challenge}:${code}`), "hex");
    if (!/^\d{6}$/.test(code) || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      db.prepare("UPDATE password_reset_codes SET attempts = attempts + 1 WHERE challenge_hash = ?").run(tokenHash(challenge));
      return null;
    }
    db.prepare("UPDATE password_reset_codes SET expires_at = 0, code_hash = '' WHERE challenge_hash = ?").run(tokenHash(challenge));
    if (!emailVerified(row.user_id, (db.prepare("SELECT email FROM users WHERE id=?").get(row.user_id) as {email:string}).email)) return null;
    return issuePasswordResetToken(row.user_id, "email");
  }).immediate();
}

export function issuePasswordRecoveryTotp(userId:string) {
  const db=getDb();
  return db.transaction(()=>{
    const now=Date.now();
    const user=db.prepare("SELECT password_hash,totp_secret,totp_enabled FROM users WHERE id=?").get(userId) as {password_hash:string;totp_secret:string;totp_enabled:number}|undefined;
    if(!user?.totp_enabled) return null;
    readTotpSecret(userId); // 先完成旧明文密钥迁移，避免错误尝试后快照变化。
    const factor=(db.prepare("SELECT totp_secret FROM users WHERE id=?").get(userId) as {totp_secret:string}).totp_secret;
    const previous=db.prepare("SELECT created_at FROM password_reset_totp WHERE user_id=?").get(userId) as {created_at:number}|undefined;
    if(previous && now-previous.created_at<60_000) return null;
    const challenge=newResetChallenge();
    db.prepare("DELETE FROM password_reset_totp WHERE expires_at<=? AND created_at<=?").run(now,now-60_000);
    db.prepare("INSERT OR REPLACE INTO password_reset_totp (user_id,challenge_hash,password_hash,factor_hash,attempts,expires_at,created_at) VALUES (?,?,?,?,0,?,?)").run(userId,tokenHash(challenge),user.password_hash,tokenHash(factor),now+RESET_TTL_MS,now);
    return {challenge};
  }).immediate();
}

export function retainedTotpChallenge(userId:string,supplied:unknown) {
  if(typeof supplied!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return null;
  return getDb().prepare("SELECT 1 FROM password_reset_totp WHERE user_id=? AND challenge_hash=?").get(userId,tokenHash(supplied))?supplied:null;
}

export function verifyPasswordRecoveryTotp(challenge:string,code:string) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  const db=getDb();
  return db.transaction(()=>{
    const row=db.prepare("SELECT t.*,u.totp_secret FROM password_reset_totp t JOIN users u ON u.id=t.user_id WHERE t.challenge_hash=? AND t.password_hash=u.password_hash AND u.totp_enabled=1").get(tokenHash(challenge)) as {user_id:string;totp_secret:string;factor_hash:string;attempts:number;expires_at:number}|undefined;
    if(!row || row.expires_at<=Date.now() || row.attempts>=5 || row.factor_hash!==tokenHash(row.totp_secret)) return null;
    db.prepare("UPDATE password_reset_totp SET attempts=attempts+1 WHERE user_id=?").run(row.user_id);
    if(!consumeTotpFactor(row.user_id,code)) return null;
    db.prepare("UPDATE password_reset_totp SET expires_at=0 WHERE user_id=?").run(row.user_id);
    return issuePasswordResetToken(row.user_id,"totp");
  }).immediate();
}
