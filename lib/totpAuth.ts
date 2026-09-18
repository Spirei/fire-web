import { createHash, randomBytes } from "crypto";
import { getDb } from "./db";
import { decryptSecret, encryptSecret } from "./secretStorage";
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  totpOtpauthUrl,
  totpQrPng,
  totpQrSvg,
  verifyBackupCode,
  verifyTotpCode
} from "./totp";

const SETUP_TTL_MS = 10 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_MAX_ATTEMPTS = 8;
const DUMMY_SECRET = generateTotpSecret();

export function userTotpEnabled(userId: string): boolean {
  const row = getDb().prepare("SELECT totp_enabled FROM users WHERE id = ?").get(userId) as { totp_enabled: number } | undefined;
  return Boolean(row?.totp_enabled);
}

export function readTotpSecret(userId: string): string {
  const row = getDb().prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string } | undefined;
  const raw = row?.totp_secret || "";
  if (!raw) return "";
  const secret = decryptSecret(raw);
  if (secret && !raw.startsWith("enc:v1:")) {
    getDb().prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(encryptSecret(secret), userId);
  }
  return secret;
}

export async function beginTotpSetup(userId: string, account: string, issuer = "Fire") {
  const secret = generateTotpSecret();
  getDb().prepare(
    "INSERT INTO totp_setup (user_id, secret, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, expires_at = excluded.expires_at"
  ).run(userId, encryptSecret(secret), Date.now() + SETUP_TTL_MS);
  const otpauthUrl = totpOtpauthUrl(issuer, account, secret);
  const [qrSvg, qrPng] = await Promise.all([totpQrSvg(otpauthUrl), totpQrPng(otpauthUrl)]);
  return { secret, otpauthUrl, qrSvg, qrPng };
}

export function enableTotp(userId: string, code: string): { ok: boolean; error?: string; backupCodes?: string[] } {
  if (userTotpEnabled(userId)) return { ok: false, error: "已经开启二次验证" };
  const pending = getDb().prepare("SELECT secret, expires_at FROM totp_setup WHERE user_id = ?").get(userId) as { secret: string; expires_at: number } | undefined;
  if (!pending || pending.expires_at < Date.now()) {
    if (pending) getDb().prepare("DELETE FROM totp_setup WHERE user_id = ?").run(userId);
    return { ok: false, error: "设置已过期，请重新开始" };
  }
  const secret = decryptSecret(pending.secret);
  const verified = verifyTotpCode(secret, code);
  if (!verified.ok) return { ok: false, error: "验证码不正确" };
  const backupCodes = generateBackupCodes();
  const hashes = backupCodes.map(hashBackupCode);
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ?, totp_last_step = ? WHERE id = ?"
    ).run(encryptSecret(secret), JSON.stringify(hashes), verified.step, userId);
    db.prepare("DELETE FROM totp_setup WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM totp_tickets WHERE user_id = ?").run(userId);
  })();
  return { ok: true, backupCodes };
}

export function disableTotp(userId: string, code: string, passwordOk: boolean): { ok: boolean; error?: string } {
  const enabled = userTotpEnabled(userId);
  const secret = passwordOk && enabled ? readTotpSecret(userId) : DUMMY_SECRET;
  const last = passwordOk && enabled ? readLastStep(userId) : -1;
  const totp = verifyTotpCode(secret, code, last);
  const backup = passwordOk && enabled ? consumeBackupCode(userId, code) : false;
  if (!passwordOk || !enabled || (!totp.ok && !backup)) {
    return { ok: false, error: "密码或验证码不正确" };
  }
  clearTotp(userId);
  return { ok: true };
}

export function consumeTotpFactor(userId: string, code: string): boolean {
  if (!userTotpEnabled(userId)) return false;
  const secret = readTotpSecret(userId);
  const last = readLastStep(userId);
  const totp = verifyTotpCode(secret, code, last);
  if (totp.ok) {
    writeLastStep(userId, totp.step);
    return true;
  }
  return consumeBackupCode(userId, code);
}

export function clearTotp(userId: string) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "UPDATE users SET totp_secret = '', totp_enabled = 0, totp_backup_codes = '[]', totp_last_step = -1 WHERE id = ?"
    ).run(userId);
    db.prepare("DELETE FROM totp_setup WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM totp_tickets WHERE user_id = ?").run(userId);
  })();
}

export function createLoginTicket(userId: string): string {
  const ticket = randomBytes(24).toString("hex");
  const now = Date.now();
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM totp_tickets WHERE user_id = ? OR expires_at < ?").run(userId, now);
    db.prepare("INSERT INTO totp_tickets (ticket_hash, user_id, expires_at, attempts) VALUES (?, ?, ?, 0)").run(
      hashTicket(ticket),
      userId,
      now + TICKET_TTL_MS
    );
  })();
  return ticket;
}

export function completeLoginTicket(ticket: string, code: string): { ok: boolean; userId?: string; error?: string } {
  const cleanedTicket = ticket.trim().toLowerCase();
  const cleanedCode = String(code ?? "").trim();
  if (!/^[0-9a-f]{48}$/.test(cleanedTicket)) return { ok: false, error: "验证已过期，请重新登录" };
  if (cleanedCode.length < 6 || cleanedCode.length > 32) return { ok: false, error: "验证码不正确" };
  const key = hashTicket(cleanedTicket);
  const now = Date.now();
  return getDb().transaction(() => {
    const db = getDb();
    const row = db.prepare("SELECT user_id, expires_at, attempts FROM totp_tickets WHERE ticket_hash = ?").get(key) as
      | { user_id: string; expires_at: number; attempts: number }
      | undefined;
    if (!row || row.expires_at < now) {
      if (row) db.prepare("DELETE FROM totp_tickets WHERE ticket_hash = ?").run(key);
      return { ok: false, error: "验证已过期，请重新登录" };
    }
    if (row.attempts >= TICKET_MAX_ATTEMPTS) {
      db.prepare("DELETE FROM totp_tickets WHERE ticket_hash = ?").run(key);
      return { ok: false, error: "尝试次数过多，请重新登录" };
    }
    db.prepare("UPDATE totp_tickets SET attempts = attempts + 1 WHERE ticket_hash = ?").run(key);
    if (!userTotpEnabled(row.user_id)) {
      db.prepare("DELETE FROM totp_tickets WHERE ticket_hash = ?").run(key);
      return { ok: false, error: "验证已失效，请重新登录" };
    }
    const secret = readTotpSecret(row.user_id);
    const last = readLastStep(row.user_id);
    const totp = verifyTotpCode(secret, cleanedCode, last);
    if (totp.ok) {
      writeLastStep(row.user_id, totp.step);
      db.prepare("DELETE FROM totp_tickets WHERE ticket_hash = ?").run(key);
      return { ok: true, userId: row.user_id };
    }
    if (consumeBackupCode(row.user_id, cleanedCode)) {
      db.prepare("DELETE FROM totp_tickets WHERE ticket_hash = ?").run(key);
      return { ok: true, userId: row.user_id };
    }
    return { ok: false, error: "验证码不正确" };
  })();
}

function readLastStep(userId: string): number {
  const row = getDb().prepare("SELECT totp_last_step FROM users WHERE id = ?").get(userId) as { totp_last_step: number } | undefined;
  return Number.isFinite(row?.totp_last_step) ? Number(row?.totp_last_step) : -1;
}

function writeLastStep(userId: string, step: number) {
  getDb().prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").run(step, userId);
}

function consumeBackupCode(userId: string, code: string): boolean {
  const row = getDb().prepare("SELECT totp_backup_codes FROM users WHERE id = ?").get(userId) as { totp_backup_codes: string } | undefined;
  let hashes: string[] = [];
  try { hashes = JSON.parse(row?.totp_backup_codes || "[]") as string[]; } catch { hashes = []; }
  if (!Array.isArray(hashes) || hashes.length === 0) return false;
  const result = verifyBackupCode(code, hashes);
  if (!result.ok) return false;
  getDb().prepare("UPDATE users SET totp_backup_codes = ? WHERE id = ?").run(JSON.stringify(result.remaining), userId);
  return true;
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

setInterval(() => {
  try {
    const now = Date.now();
    const db = getDb();
    db.prepare("DELETE FROM totp_setup WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM totp_tickets WHERE expires_at < ?").run(now);
  } catch {
    /* 清理失败不影响请求 */
  }
}, 60_000).unref();
