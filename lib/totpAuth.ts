import { createHash, randomBytes } from "crypto";
import { getDb } from "./db";
import {
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  totpOtpauthUrl,
  totpQrSvg,
  verifyBackupCode,
  verifyTotpCode
} from "./totp";

const SETUP_TTL_MS = 10 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_MAX_ATTEMPTS = 8;

const pendingSetup = new Map<string, { secret: string; expiresAt: number }>();
const pendingTickets = new Map<string, { userId: string; expiresAt: number; attempts: number }>();

export function userTotpEnabled(userId: string): boolean {
  const row = getDb().prepare("SELECT totp_enabled FROM users WHERE id = ?").get(userId) as { totp_enabled: number } | undefined;
  return Boolean(row?.totp_enabled);
}

export function readTotpSecret(userId: string): string {
  const row = getDb().prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string } | undefined;
  return row?.totp_secret || "";
}

export async function beginTotpSetup(userId: string, account: string, issuer = "Fire") {
  const secret = generateTotpSecret();
  pendingSetup.set(userId, { secret, expiresAt: Date.now() + SETUP_TTL_MS });
  const otpauthUrl = totpOtpauthUrl(issuer, account, secret);
  const qrSvg = await totpQrSvg(otpauthUrl);
  return { secret, otpauthUrl, qrSvg };
}

export function enableTotp(userId: string, code: string): { ok: boolean; error?: string; backupCodes?: string[] } {
  const pending = pendingSetup.get(userId);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingSetup.delete(userId);
    return { ok: false, error: "设置已过期，请重新开始" };
  }
  const verified = verifyTotpCode(pending.secret, code);
  if (!verified.ok) return { ok: false, error: "验证码不正确" };
  const backupCodes = generateBackupCodes();
  const hashes = backupCodes.map(hashBackupCode);
  getDb().prepare(
    "UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ?, totp_last_step = ? WHERE id = ?"
  ).run(pending.secret, JSON.stringify(hashes), verified.step, userId);
  pendingSetup.delete(userId);
  return { ok: true, backupCodes };
}

export function disableTotp(userId: string, code: string, passwordOk: boolean): { ok: boolean; error?: string } {
  if (!passwordOk) return { ok: false, error: "密码不正确" };
  if (!userTotpEnabled(userId)) return { ok: false, error: "尚未开启二次验证" };
  const secret = readTotpSecret(userId);
  const last = readLastStep(userId);
  const totp = verifyTotpCode(secret, code, last);
  const backup = consumeBackupCode(userId, code);
  if (!totp.ok && !backup) return { ok: false, error: "验证码不正确" };
  if (totp.ok) writeLastStep(userId, totp.step);
  clearTotp(userId);
  pendingSetup.delete(userId);
  return { ok: true };
}

export function clearTotp(userId: string) {
  getDb().prepare(
    "UPDATE users SET totp_secret = '', totp_enabled = 0, totp_backup_codes = '[]', totp_last_step = -1 WHERE id = ?"
  ).run(userId);
}

export function createLoginTicket(userId: string): string {
  const ticket = randomBytes(24).toString("hex");
  pendingTickets.set(hashTicket(ticket), { userId, expiresAt: Date.now() + TICKET_TTL_MS, attempts: 0 });
  return ticket;
}

export function completeLoginTicket(ticket: string, code: string): { ok: boolean; userId?: string; error?: string } {
  const key = hashTicket(ticket);
  const row = pendingTickets.get(key);
  if (!row || row.expiresAt < Date.now()) {
    pendingTickets.delete(key);
    return { ok: false, error: "验证已过期，请重新登录" };
  }
  row.attempts += 1;
  if (row.attempts > TICKET_MAX_ATTEMPTS) {
    pendingTickets.delete(key);
    return { ok: false, error: "尝试次数过多，请重新登录" };
  }
  if (!userTotpEnabled(row.userId)) {
    pendingTickets.delete(key);
    return { ok: false, error: "验证已失效，请重新登录" };
  }
  const secret = readTotpSecret(row.userId);
  const last = readLastStep(row.userId);
  const totp = verifyTotpCode(secret, code, last);
  if (totp.ok) {
    writeLastStep(row.userId, totp.step);
    pendingTickets.delete(key);
    return { ok: true, userId: row.userId };
  }
  if (consumeBackupCode(row.userId, code)) {
    pendingTickets.delete(key);
    return { ok: true, userId: row.userId };
  }
  pendingTickets.set(key, row);
  return { ok: false, error: "验证码不正确" };
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
  const now = Date.now();
  for (const [key, value] of pendingSetup) if (value.expiresAt < now) pendingSetup.delete(key);
  for (const [key, value] of pendingTickets) if (value.expiresAt < now) pendingTickets.delete(key);
}, 60_000).unref();
