import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { getSiteSettings } from "./settings";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function emailVerified(userId: string, email: string) {
  return Boolean(email && getDb().prepare("SELECT 1 FROM verified_emails WHERE user_id=? AND LOWER(email)=LOWER(?)").get(userId,email));
}
export function verificationOrigin(request: Request) {
  const configured = getSiteSettings().domain.trim();
  if (configured && configured !== "localhost:3000") {
    try {
      const candidate = new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`);
      if (!["http:","https:"].includes(candidate.protocol) || candidate.username || candidate.password) return "";
      return candidate.origin;
    } catch { return ""; }
  }
  return process.env.NODE_ENV !== "production" ? new URL(request.url).origin : "";
}
export function issueEmailVerification(userId: string, beforeIssue?: (email: string) => void) {
  const db=getDb();
  return db.transaction(()=>{
    const user=db.prepare("SELECT email,password_hash FROM users WHERE id=?").get(userId) as {email:string;password_hash:string}|undefined;
    if(!user?.email) return null;
    const now=Date.now();
    const previous=db.prepare("SELECT created_at FROM email_verification_tokens WHERE user_id=?").get(userId) as {created_at:number}|undefined;
    if(previous && now-previous.created_at<60_000) return null;
    beforeIssue?.(user.email);
    const token=randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM email_verification_tokens WHERE expires_at<=? AND created_at<=?").run(now,now-60_000);
    db.prepare("INSERT OR REPLACE INTO email_verification_tokens (user_id,token_hash,email,password_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)").run(userId,digest(token),user.email,user.password_hash,now+30*60_000,now);
    return {token,email:user.email};
  }).immediate();
}
export function revokeEmailVerification(token:string) {
  getDb().prepare("UPDATE email_verification_tokens SET expires_at=0 WHERE token_hash=?").run(digest(token));
}
export function confirmEmailVerification(token:string) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const db=getDb();
  return db.transaction(()=>{
    const row=db.prepare("SELECT t.user_id,t.email FROM email_verification_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.expires_at>? AND t.password_hash=u.password_hash AND LOWER(t.email)=LOWER(u.email)").get(digest(token),Date.now()) as {user_id:string;email:string}|undefined;
    if(!row) return false;
    db.prepare("INSERT OR REPLACE INTO verified_emails (user_id,email,verified_at) VALUES (?,?,?)").run(row.user_id,row.email,Date.now());
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id=?").run(row.user_id);
    return true;
  }).immediate();
}
