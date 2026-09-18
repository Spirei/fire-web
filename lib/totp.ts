import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import QRCode from "qrcode";
import { hmacWithDataKey } from "./secretStorage";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;
const WINDOW = 1;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpOtpauthUrl(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(issuer)}`,
    `digits=${CODE_DIGITS}`,
    `period=${STEP_SECONDS}`
  ].join("&");
  return `otpauth://totp/${label}?${query}`;
}

export async function totpQrSvg(otpauthUrl: string): Promise<string> {
  return QRCode.toString(otpauthUrl, { type: "svg", margin: 2, width: 240, errorCorrectionLevel: "M" });
}

export async function totpQrPng(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { type: "image/png", margin: 2, width: 240, errorCorrectionLevel: "M" });
}

export function formatTotpSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(8).toString("hex");
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
  });
}

export function hashBackupCode(code: string): string {
  return `v2:${hmacWithDataKey(normalizeBackupCode(code))}`;
}

export function normalizeBackupCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
}

export function verifyBackupCode(code: string, hashes: string[]): { ok: boolean; remaining: string[] } {
  if (!Array.isArray(hashes) || hashes.length === 0) return { ok: false, remaining: [] };
  const normalized = normalizeBackupCode(code);
  if (normalized.length < 8) return { ok: false, remaining: hashes };
  const digestV2 = `v2:${hmacWithDataKey(normalized)}`;
  const digestV1 = createHash("sha256").update(normalized).digest("hex");
  const index = hashes.findIndex((item) => {
    const target = item.startsWith("v2:") ? digestV2 : digestV1;
    try {
      return item.length === target.length && timingSafeEqual(Buffer.from(item), Buffer.from(target));
    } catch {
      return false;
    }
  });
  if (index < 0) return { ok: false, remaining: hashes };
  return { ok: true, remaining: hashes.filter((_, i) => i !== index) };
}

export function totpCodeAt(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  return hotp(secret, Math.floor(unixSeconds / STEP_SECONDS));
}

export function verifyTotpCode(secret: string, code: string, lastStep = -1): { ok: boolean; step: number } {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, step: lastStep };
  const now = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const expected = Buffer.from(cleaned);
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    const step = now + delta;
    if (step <= lastStep) continue;
    const candidate = Buffer.from(totpCodeAt(secret, step * STEP_SECONDS));
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true, step };
    }
  }
  return { ok: false, step: lastStep };
}

function hotp(secret: string, step: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  msg.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, "0");
}

function base32Encode(bytes: Buffer): string {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += BASE32[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
