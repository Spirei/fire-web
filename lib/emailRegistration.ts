import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "./db";
import { applySessionCookie, createSession, createUser, findUserByEmail, getUserByToken, isTrustedMutationRequest, needsSetup } from "./auth";
import { getSiteSettings } from "./settings";
import { mailConfigured, sendRegistrationCode } from "./mail";
import { MailBudgetError, reserveMailAttempt, type MailPermit } from "./mailBudget";
import { readAuthObject } from "./authInput";
import { AuthBudgetError, authBudgetHeaders, registrationAttempt, registrationCreation } from "./authAbuse";
import { validatePassword } from "./password";

const ttl = 1800, digest = (value: string) => createHash("sha256").update(value).digest("hex");
class RegistrationError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function normalizedRegistrationEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+\/=?^_{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(email) ? email : null;
}
export function emailRegistrationDiscovery() {
  return {supported: getSiteSettings().allowRegister && mailConfigured() && !needsSetup(), version: 1,
    request_path: "/api/auth/register/email/request", confirm_path: "/api/auth/register/email/confirm",
    code_digits: 6, challenge_ttl_seconds: ttl, retry_after_seconds: 60, max_attempts: 5};
}
function open() {
  // The first administrator must still use the installation-token workflow.
  if (needsSetup() || !getSiteSettings().allowRegister) throw new RegistrationError("注册暂未开放", 403);
}
export async function emailRegistration(request: Request, action: "request" | "confirm") {
  const headers = {"Cache-Control": "no-store"};
  try {
    if (!isTrustedMutationRequest(request)) throw new RegistrationError("请求来源不受信任", 403);
    registrationAttempt(request); open();
    const body = await readAuthObject(request, action === "request" ? ["email"] : ["email", "challenge", "code", "password"]);
    const email = normalizedRegistrationEmail(body?.email);
    if (!body || !email) throw new RegistrationError("请填写有效邮箱");
    const db = getDb(), now = Date.now(), origin = new URL(request.url).origin;
    if (action === "request") {
      if (!mailConfigured()) throw new RegistrationError("邮箱注册暂不可用", 503);
      const challenge = randomBytes(32).toString("base64url"), code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      let permit: MailPermit | undefined;
      const delivery = db.transaction(() => {
        open();
        // Persist send budgets even when SMTP fails, and never create a user here.
        permit = reserveMailAttempt(email, "verification");
        db.prepare("DELETE FROM registration_email_challenges WHERE expires_at<=?").run(now);
        if (findUserByEmail(email)) return false;
        db.prepare("DELETE FROM registration_email_challenges WHERE email_key=?").run(digest(email));
        db.prepare("INSERT INTO registration_email_challenges(challenge_hash,email_key,email,origin,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(digest(challenge), digest(email), email, origin, digest(`${challenge}:${code}`), now + ttl * 1000, now);
        return true;
      }).immediate();
      if (delivery) {
        try { await sendRegistrationCode(email, code, permit!); }
        catch {
          db.prepare("DELETE FROM registration_email_challenges WHERE challenge_hash=?").run(digest(challenge));
          throw new RegistrationError("验证码发送未确认，请稍后重试", 503);
        }
      }
      // Existing addresses get the same receipt, without another mail or a login grant.
      return NextResponse.json({challenge, email, expires_in: ttl, retry_after: 60}, {headers});
    }
    if (typeof body.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.challenge)
      || typeof body.code !== "string" || !/^\d{6}$/.test(body.code) || typeof body.password !== "string") throw new RegistrationError("验证码格式无效");
    const passwordError = validatePassword(body.password); if (passwordError) throw new RegistrationError(passwordError);
    const challenge = body.challenge, code = body.code, password = body.password;
    const outcome = db.transaction(() => {
      open();
      const row = db.prepare("SELECT * FROM registration_email_challenges WHERE challenge_hash=?").get(digest(challenge)) as {email: string; origin: string; code_hash: string; attempts: number; expires_at: number} | undefined;
      if (!row || row.email !== email || row.origin !== origin || row.expires_at <= Date.now() || row.attempts >= 5) return null;
      // Return on a bad attempt so its count is committed, never rolled back.
      db.prepare("UPDATE registration_email_challenges SET attempts=attempts+1 WHERE challenge_hash=?").run(digest(challenge));
      if (!timingSafeEqual(Buffer.from(row.code_hash, "hex"), Buffer.from(digest(`${challenge}:${code}`), "hex"))) return null;
      if (findUserByEmail(email)) { db.prepare("DELETE FROM registration_email_challenges WHERE challenge_hash=?").run(digest(challenge)); return null; }
      registrationCreation(request);
      // The public username never reveals the private email address.
      const user = createUser("user_" + randomBytes(6).toString("hex"), password, false, email);
      if (user.role !== "user") throw new Error("Unexpected setup transition");
      db.prepare("INSERT INTO verified_emails(user_id,email,verified_at) VALUES(?,?,?)").run(user.id, email, Date.now());
      const token = createSession(user.id);
      db.prepare("DELETE FROM registration_email_challenges WHERE challenge_hash=?").run(digest(challenge));
      return {user: getUserByToken(token)!, token};
    }).immediate();
    if (!outcome) throw new RegistrationError("验证码错误或已失效，请重新核对", 400);
    const response = NextResponse.json({user: outcome.user}, {status: 201, headers});
    applySessionCookie(response, outcome.token, request); return response;
  } catch (error) {
    if (error instanceof AuthBudgetError) return NextResponse.json({error: error.message}, {status: error.unavailable ? 503 : 429, headers: authBudgetHeaders(error)});
    if (error instanceof MailBudgetError) return NextResponse.json({error: "发送过于频繁，请稍后再试"}, {status: 429, headers: {...headers, "Retry-After": "60"}});
    return NextResponse.json({error: error instanceof RegistrationError ? error.message : "注册结果未确认，请尝试登录"}, {status: error instanceof RegistrationError ? error.status : 503, headers});
  }
}
