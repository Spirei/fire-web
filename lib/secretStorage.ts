import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "enc:v1:";
let cachedKey: Buffer | null = null;

function key() {
  if (cachedKey) return cachedKey;
  const configured = process.env.FIRE_ENCRYPTION_KEY?.trim();
  if (configured) return cachedKey = createHash("sha256").update(configured).digest();
  const file = path.join(process.cwd(), "data", ".fire-encryption-key");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let raw: Buffer;
  try { raw = fs.readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = randomBytes(32);
    try { fs.writeFileSync(file, raw, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      raw = fs.readFileSync(file);
    }
  }
  if (raw.length < 32) throw new Error("加密密钥文件无效，请恢复原有密钥文件");
  try { fs.chmodSync(file, 0o600); } catch { /* Some mounted filesystems do not support chmod. */ }
  return cachedKey = createHash("sha256").update(raw).digest();
}

export function encryptSecret(value: string) {
  if (!value) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value: string, strict = false) {
  if (!value.startsWith(PREFIX)) return value;
  try {
    const [iv, tag, payload] = value.slice(PREFIX.length).split(":").map(part => Buffer.from(part, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  } catch {
    if (strict) throw new Error("已保存的密钥无法解密，请检查加密密钥或恢复备份");
    return "";
  }
}

export function hmacWithDataKey(value: string) {
  return createHmac("sha256", key()).update(value).digest("hex");
}
