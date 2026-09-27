import { createHash } from "node:crypto";
import { getDb } from "./db";

export type MailPurpose = "reset" | "verification" | "test";
export type MailPermit = Readonly<{ recipient: string; purpose: MailPurpose }>;
const permits = new WeakSet<MailPermit>();
export class MailBudgetError extends Error {
  constructor() { super("发送过于频繁，请稍后再试"); }
}

/** Sliding budgets shared by all SMTP entry points/workers. Fail closed, never fall back to memory. */
export function reserveMailAttempt(recipient: string, purpose: MailPurpose) {
  // Only a single plain mailbox is allowed; never let Nodemailer's address-list parser fan out.
  const email = recipient.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(email)) throw new Error("邮箱格式无效");
  const hash = createHash("sha256").update(email).digest("hex");
  const hour = 60 * 60_000, day = 24 * hour;
  try {
    getDb().transaction(() => {
      const db = getDb(), now = Date.now();
      db.prepare("DELETE FROM mail_send_attempts WHERE created_at <= ?").run(now - day);
      const count = (since: number, mailbox?: string, kind?: MailPurpose) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM mail_send_attempts WHERE created_at > ?${mailbox ? " AND recipient_hash = ?" : ""}${kind ? " AND purpose = ?" : ""}`)
          .get(since, ...(mailbox ? [mailbox] : []), ...(kind ? [kind] : [])) as { count: number };
        return row.count;
      };
      if (count(now - 60_000, hash) >= 1 || count(now - hour, hash) >= 8 || count(now - day, hash) >= 20
        || count(now - hour) >= 100 || count(now - day) >= 500
        || (purpose === "reset" && (count(now - hour, hash, purpose) >= 3 || count(now - day, hash, purpose) >= 10))
        || (purpose === "verification" && (count(now - hour, hash, purpose) >= 5 || count(now - day, hash, purpose) >= 10))
        || (purpose === "test" && count(now - hour, hash, purpose) >= 3)) throw new MailBudgetError();
      // Reserve before opening SMTP; failed/timeout sends also consume budget. No automatic retry.
      db.prepare("INSERT INTO mail_send_attempts (recipient_hash,purpose,created_at) VALUES (?,?,?)").run(hash, purpose, now);
    }).immediate();
    const permit: MailPermit = Object.freeze({ recipient: email, purpose });
    permits.add(permit);
    return permit;
  } catch (error) {
    if (error instanceof MailBudgetError) throw error;
    throw new Error("邮件服务暂不可用，请稍后重试");
  }
}

/** In-process, single-use permits let recovery reserve inside its credential transaction. */
export function consumeMailPermit(recipient: string, purpose: MailPurpose, permit?: MailPermit) {
  const admitted = permit || reserveMailAttempt(recipient, purpose);
  if (!permits.has(admitted) || admitted.recipient !== recipient.trim().toLowerCase() || admitted.purpose !== purpose) throw new Error("邮件发送凭证无效");
  permits.delete(admitted);
}
