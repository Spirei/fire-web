import crypto from "node:crypto";

const VERSION = "v1";
function key() {
  const secret = process.env.DEPLOY_STATUS_SECRET;
  if (!secret || secret.length < 16) throw new Error("服务端未配置 DEPLOY_STATUS_SECRET（至少 16 位）");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptDeploySecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${VERSION}:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptDeploySecret(value: string) {
  if (!value || !value.startsWith(`${VERSION}:`)) return "";
  const [, ivRaw, tagRaw, dataRaw] = value.split(":");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64url")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}
