import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { appTokenHash, appSecurityStamp } from "./appAuth";
import { securityGrant, securityBody, SecurityError } from "./appSecurity";
import { findUserById, findUserByEmail, updatePassword, updateProfile, deleteOtherSessions } from "./auth";
import { getDb } from "./db";
import { validatePassword, verifyPassword } from "./password";
import { rateLimit, rateLimitGlobal, clientIp } from "./rateLimit";
import { mailConfigured, sendAccountEmailChangeCode } from "./mail";
import { reserveMailAttempt, MailBudgetError, type MailPermit } from "./mailBudget";
import { logSecurityEvent } from "./securityAudit";

type Purpose = "password" | "email";
type State = {user_id:string;grant_id:string;purpose:Purpose;stage:string;identity_version:number;security_stamp:string;email:string;code_hash:string;attempts:number;expires_at:number;created_at:number};
const ttl = 300_000;
const validToken = (token:string) => /^[A-Za-z0-9_-]{43}$/.test(token);
function currentStamp(userId:string) {
  return appSecurityStamp(getDb().prepare("SELECT password_hash,totp_enabled,totp_secret FROM users WHERE id=?").get(userId) as {password_hash:string;totp_enabled:number;totp_secret:string});
}
function identityVersion(userId:string) {
  return (getDb().prepare("SELECT version FROM account_change_versions WHERE user_id=?").get(userId) as {version:number}|undefined)?.version || 0;
}
function liveState(request:Request, token:string, purpose:Purpose, stage:string) {
  const grant=securityGrant(request,true), row=findUserById(grant.user_id);
  const state=validToken(token) ? getDb().prepare("SELECT * FROM app_account_changes WHERE token_hash=? AND user_id=? AND grant_id=? AND purpose=? AND stage=?").get(appTokenHash(token),grant.user_id,grant.id,purpose,stage) as State|undefined : undefined;
  if (!row || !state || state.expires_at<=Date.now() || state.identity_version!==identityVersion(grant.user_id) || state.email!==row.email || state.security_stamp!==currentStamp(grant.user_id)) return null;
  return state;
}
function issueProof(request:Request,purpose:Purpose) {
  const db=getDb(), grant=securityGrant(request,true), row=findUserById(grant.user_id)!;
  const proof=randomBytes(32).toString("base64url"), expiresAt=Date.now()+ttl;
  db.prepare("DELETE FROM app_account_changes WHERE user_id=? AND purpose=? AND stage='proof'").run(grant.user_id,purpose);
  db.prepare("INSERT INTO app_account_changes(token_hash,user_id,grant_id,purpose,stage,identity_version,security_stamp,email,expires_at,created_at) VALUES(?,?,?,?,'proof',?,?,?,?,?)")
    .run(appTokenHash(proof),grant.user_id,grant.id,purpose,identityVersion(grant.user_id),currentStamp(grant.user_id),row.email,expiresAt,Date.now());
  return {ok:true,proof,expiresAt};
}

/** Native-only stepwise contract. All state checks and mutation use the same write lock. */
export async function accountChange(request:Request,purpose:Purpose,action:"request"|"verify"|"confirm") {
  const initial=securityGrant(request,true), db=getDb();
  if (!rateLimit(`account-change:${purpose}:${initial.user_id}`,30,15*60_000) || !rateLimit(`account-change-ip:${clientIp(request)}`,100,15*60_000) || !rateLimitGlobal("account-change",500,15*60_000)) throw new SecurityError("尝试过于频繁",42901,429);
  const fields=action==="request"?[]:action==="verify"?(purpose==="password"?["currentPassword"]:["challenge","code"]):["proof",purpose==="password"?"newPassword":"email"];
  const body=await securityBody(request,fields);
  if (action==="request") {
    if(purpose!=="email") throw new SecurityError("不支持此操作");
    if(!rateLimit(`account-change-email-send:${initial.user_id}`,5,15*60_000) || !rateLimit(`account-change-email-day:${initial.user_id}`,10,24*60*60_000)) throw new SecurityError("发送过于频繁",42901,429);
    let permit:MailPermit|undefined;
    const delivery=db.transaction(()=>{
      const grant=securityGrant(request,true), row=findUserById(grant.user_id)!;
      if(!row.email) throw new SecurityError("请先绑定邮箱",40902,409);
      if(!mailConfigured()) throw new SecurityError("邮件服务尚未配置",50301,503);
      const previous=db.prepare("SELECT created_at FROM app_account_changes WHERE user_id=? AND purpose='email' AND stage='code' ORDER BY created_at DESC LIMIT 1").get(grant.user_id) as {created_at:number}|undefined;
      if(previous && Date.now()-previous.created_at<60_000) throw new SecurityError("请在60秒后重试",42901,429);
      try {permit=reserveMailAttempt(row.email,"verification");} catch(error) {if(error instanceof MailBudgetError) throw new SecurityError(error.message,42901,429);throw error;}
      const challenge=randomBytes(32).toString("base64url"), code=randomInt(0,1_000_000).toString().padStart(6,"0"), now=Date.now();
      db.prepare("DELETE FROM app_account_changes WHERE (user_id=? AND purpose='email') OR (expires_at<=? AND created_at<=?)").run(grant.user_id,now,now-60_000);
      db.prepare("INSERT INTO app_account_changes(token_hash,user_id,grant_id,purpose,stage,identity_version,security_stamp,email,code_hash,expires_at,created_at) VALUES(?,?,?,'email','code',?,?,?,?,?,?)")
        .run(appTokenHash(challenge),grant.user_id,grant.id,identityVersion(grant.user_id),currentStamp(grant.user_id),row.email,appTokenHash(`${challenge}:${code}`),now+ttl,now);
      return {challenge,code,email:row.email,expiresAt:now+ttl};
    }).immediate();
    try {await sendAccountEmailChangeCode(delivery.email,delivery.code,permit!);} catch {
      db.prepare("UPDATE app_account_changes SET expires_at=0,code_hash='' WHERE token_hash=?").run(appTokenHash(delivery.challenge));
      throw new SecurityError("邮件发送失败，请稍后重试",50002,502);
    }
    // A revoke or identity change during SMTP cannot leave a usable challenge.
    const stillLive=db.transaction(()=>liveState(request,delivery.challenge,"email","code")).immediate();
    if(!stillLive) throw new SecurityError("验证流程已失效，请重新开始",40003,400);
    logSecurityEvent(request,initial.user_id,"app.email_change.requested","code sent to current mailbox");
    return {ok:true,challenge:delivery.challenge,expiresAt:delivery.expiresAt,retryAfter:60};
  }
  if(action==="verify") {
    const result=db.transaction(()=>{
      const grant=securityGrant(request,true), row=findUserById(grant.user_id)!;
      if(purpose==="password") {
        if(!body.currentPassword || body.currentPassword.length>128 || !verifyPassword(body.currentPassword,row.password_hash)) throw new SecurityError("原密码错误",40103,403);
      } else {
        const state=liveState(request,body.challenge || "","email","code");
        if(!state || state.attempts>=5) return null;
        const expected=Buffer.from(state.code_hash,"hex"), actual=Buffer.from(appTokenHash(`${body.challenge}:${body.code || ""}`),"hex");
        // Return instead of throwing: failed attempts must persist across transactions.
        db.prepare("UPDATE app_account_changes SET attempts=attempts+1 WHERE token_hash=?").run(appTokenHash(body.challenge));
        if(!/^\d{6}$/.test(body.code || "") || expected.length!==actual.length || !timingSafeEqual(expected,actual)) return null;
        db.prepare("UPDATE app_account_changes SET expires_at=0,code_hash='' WHERE token_hash=?").run(appTokenHash(body.challenge));
      }
      return issueProof(request,purpose);
    }).immediate();
    if(!result) throw new SecurityError("验证码错误或已失效",40003,400);
    return result;
  }
  if(purpose==="password") {const error=validatePassword(body.newPassword || "");if(error)throw new SecurityError(error);}
  const email=(body.email || "").trim().toLowerCase();
  if(purpose==="email" && (email.length>254 || !/^[a-z0-9.!#$%&'*+\/=?^_{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(email))) throw new SecurityError("邮箱格式不正确");
  db.transaction(()=>{
    const state=liveState(request,body.proof || "",purpose,"proof");
    if(!state) throw new SecurityError("验证凭证错误或已失效",40003,400);
    if(purpose==="password") {
      if(!updatePassword(state.user_id,body.newPassword)) throw new Error("Account unavailable");
    } else {
      if(email===state.email.trim().toLowerCase()) throw new SecurityError("请填写新的邮箱",40902,409);
      const conflict=findUserByEmail(email);
      if(conflict && conflict.id!==state.user_id) throw new SecurityError("该邮箱已被其他账号绑定",40901,409);
      if(!updateProfile(state.user_id,{email})) throw new Error("Account unavailable");
    }
    deleteOtherSessions(state.user_id,null);
    db.prepare("DELETE FROM totp_tickets WHERE user_id=?").run(state.user_id);
    db.prepare("DELETE FROM app_login_challenges WHERE user_id=?").run(state.user_id);
    db.prepare("DELETE FROM app_account_changes WHERE user_id=?").run(state.user_id);
    logSecurityEvent(request,state.user_id,`app.${purpose}_change`,"stepwise verification; all sessions and grants revoked");
  }).immediate();
  return {ok:true,reauthenticationRequired:true};
}
