import { after } from "next/server";
import { assertAppOrigin } from "./appAuth";
import { findUserByLogin, updatePassword, deleteOtherSessions } from "./auth";
import { emailVerified } from "./emailVerification";
import { mailConfigured, sendPasswordResetEmail } from "./mail";
import { reserveMailAttempt, type MailPermit } from "./mailBudget";
import { newResetChallenge, issuePasswordResetCode, retainedResetChallenge, revokePasswordResetCode, verifyPasswordResetCode, consumePasswordResetToken, PASSWORD_RESET_MINUTES } from "./passwordReset";
import { rateLimit, rateLimitGlobal, clientIp } from "./rateLimit";
import { SecurityError, securityBody } from "./appSecurity";
import { validatePassword } from "./password";
import { logSecurityEvent } from "./securityAudit";

export async function passwordRecovery(request: Request, action: "request" | "verify" | "confirm") {
  try { assertAppOrigin(request); } catch { throw new SecurityError("请求来源不受信任",40301,403); }
  const limit=action === "request" ? 5 : action === "verify" ? 20 : 10;
  // Share public Web budgets so switching API versions cannot bypass limits.
  if (!rateLimit(`password-reset-${action}:${clientIp(request)}`,limit,15*60_000) || !rateLimitGlobal(`password-reset-${action}`,action === "request" ? 80 : action === "verify" ? 200 : 120,15*60_000)) throw new SecurityError("请求过于频繁",42901,429);
  const body=await securityBody(request,action === "request" ? ["login","challenge"] : action === "verify" ? ["challenge","code"] : ["token","newPassword"]);
  if (action === "request") {
    if (!body.login?.trim() || body.login.length>160) throw new SecurityError("请输入用户名或邮箱");
    const user=findUserByLogin(body.login.trim());
    let challenge=newResetChallenge();
    if (user?.email && emailVerified(user.id,user.email) && mailConfigured()) {
      let permit: MailPermit|undefined;
      let issued: ReturnType<typeof issuePasswordResetCode>=null;
      try { issued=issuePasswordResetCode(user.id,email=>{permit=reserveMailAttempt(email,"reset");}); }
      catch { /* Quota and SMTP setup failures must not identify an account. */ }
      if (issued) {
        challenge=issued.challenge;
        const delivery=issued;
        after(async()=>{
          try { await sendPasswordResetEmail({to:delivery.email,name:user.nickname || user.username,code:delivery.code,minutes:PASSWORD_RESET_MINUTES,native:true},permit); }
          catch { revokePasswordResetCode(delivery.challenge); }
        });
      } else { challenge=retainedResetChallenge(user.id,body.challenge) || challenge; }
    }
    return {ok:true,challenge,retryAfter:60,message:"如果账号已绑定并验证邮箱，验证码会发送至该邮箱。请检查收件箱与垃圾邮件。"};
  }
  if (action === "verify") {
    const verified=verifyPasswordResetCode(body.challenge || "",body.code?.trim() || "");
    if (!verified) throw new SecurityError("验证码错误或已失效",40003,400);
    return {ok:true,token:verified.token,expiresAt:verified.expiresAt};
  }
  const error=validatePassword(body.newPassword || "");
  if(error) throw new SecurityError(error);
  const userId=consumePasswordResetToken(body.token || "",id=>{
    if (!updatePassword(id,body.newPassword)) throw new Error("Account unavailable");
    deleteOtherSessions(id,null);
  });
  if (!userId) throw new SecurityError("验证凭证错误或已失效",40003,400);
  logSecurityEvent(request,userId,"app.password_reset","verified recovery; all sessions revoked");
  return {ok:true,reauthenticationRequired:true};
}
