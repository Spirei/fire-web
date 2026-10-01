import { randomBytes } from "node:crypto";
import { appIdentity, appTokenHash, listAppDevices, revokeAppGrant } from "./appAuth";
import { appProfile } from "./appProfile";
import { findUserById, deleteOtherSessions, getAuthUser } from "./auth";
import { getDb } from "./db";
import { verifyPassword } from "./password";
import { userTotpEnabled, consumeTotpFactor, enableTotp, clearTotp } from "./totpAuth";
import { generateTotpSecret, totpOtpauthUrl, totpQrPng, generateBackupCodes, hashBackupCode } from "./totp";
import { encryptSecret } from "./secretStorage";
import { readJsonBody } from "./requestBody";
import { rateLimit, rateLimitGlobal, clientIp } from "./rateLimit";
import { fail, ok } from "./api";
import { listPasskeys } from "./passkeys";
import { nativePasskeyRegistration } from "./appSecurityConfig";
import { logSecurityEvent } from "./securityAudit";
import { emailVerified, confirmEmailVerification, issueEmailVerification, revokeEmailVerification, verificationOrigin } from "./emailVerification";
import { mailConfigured, sendEmailVerification } from "./mail";
import { reserveMailAttempt, MailBudgetError, type MailPermit } from "./mailBudget";

export class SecurityError extends Error {
  constructor(message: string, public code = 40001, public status = 400) { super(message); }
}
export function securityGrant(request: Request, write = false) {
  const token = request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
  const grant = token && appIdentity(token, request);
  if (!grant) throw new SecurityError("登录或连接已失效", 40101, 401);
  if (!grant.scope.split(" ").includes(write ? "security.write" : "security.read")) throw new SecurityError("请明确授权账户安全权限", 40301, 403);
  return grant;
}
export async function securityBody(request: Request, fields: string[]) {
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)) || Object.values(body).some(value => typeof value !== "string" || value.length > 1024)) throw new SecurityError("请求参数无效");
  return body as Record<string, string>;
}
function connectionRequiresReauthentication(request: Request) {
  const token = request.headers.get("authorization")!.slice(7);
  // Legacy secret encryption can invalidate the original security stamp too.
  return !appIdentity(token,request);
}
function stepUp(userId: string, body: Record<string, string>, factor = true) {
  const row = findUserById(userId);
  if (!row || !body.currentPassword || body.currentPassword.length > 128 || !verifyPassword(body.currentPassword, row.password_hash)) throw new SecurityError("当前密码不正确", 40103, 403);
  if (factor && userTotpEnabled(userId) && !consumeTotpFactor(userId, body.code || "")) throw new SecurityError("二次验证失败", 40104, 403);
}
function budget(request: Request, userId: string, action: string) {
  const shared = action === "totp-confirm" ? "totp-enable" : action === "passkey-remove" ? "passkey-manage" : action;
  const maximum = action === "totp-setup" ? 8 : action === "passkey-remove" ? 15 : 20;
  if (!rateLimit(`${shared}:${userId}`, maximum, 15 * 60_000) || !rateLimit(`native-security-ip:${clientIp(request)}`, 100, 15 * 60_000) || !rateLimitGlobal("native-security", 500, 15 * 60_000)) throw new SecurityError("尝试过于频繁", 42901, 429);
}
export async function securityResponse(operation: () => unknown | Promise<unknown>, request?: Request) {
  try { return ok(await operation()); }
  catch (error) {
    if (request && error instanceof SecurityError && [40103,40104].includes(error.code) && rateLimit("native-security-rejection-log",100,60_000)) {
      try { const grant=securityGrant(request,true); logSecurityEvent(request,grant.user_id,"app.security.rejected",error.code === 40103 ? "password mismatch" : "factor mismatch"); } catch { /* Auditing cannot change the operation result. */ }
    }
    return fail(error instanceof SecurityError ? error.code : 50001, error instanceof SecurityError ? error.message : "账户安全操作失败，请稍后再试", error instanceof SecurityError ? error.status : 500); }
}
export function readTotp(request: Request) {
  const grant = securityGrant(request);
  const row = getDb().prepare("SELECT totp_enabled,totp_device_name,totp_backup_codes FROM users WHERE id=?").get(grant.user_id) as {totp_enabled:number;totp_device_name:string;totp_backup_codes:string};
  return { enabled: !!row.totp_enabled, name: row.totp_enabled ? row.totp_device_name : "", backupCodesRemaining: row.totp_enabled ? JSON.parse(row.totp_backup_codes).length : 0 };
}
export async function mutateTotp(request: Request, action: "setup" | "confirm" | "disable" | "backup-codes") {
  const initial = securityGrant(request, true);
  budget(request, initial.user_id, `totp-${action}`);
  const body = await securityBody(request, action === "setup" ? ["currentPassword"] : action === "confirm" ? ["challengeId", "currentPassword", "code", "name"] : ["currentPassword", "code"]);
  if (action === "setup") {
    // Authorize before expensive QR work, then authorize again before storing anything.
    getDb().transaction(() => { securityGrant(request, true); stepUp(initial.user_id, body, false); if (userTotpEnabled(initial.user_id)) throw new SecurityError("已经开启两步验证",40902,409); }).immediate();
    const secret = generateTotpSecret(), otpauthUrl = totpOtpauthUrl("Alcor", initial.username, secret);
    const qrPng = await totpQrPng(otpauthUrl);
    return getDb().transaction(() => {
      const grant = securityGrant(request, true);
      stepUp(grant.user_id, body, false);
      if (userTotpEnabled(grant.user_id)) throw new SecurityError("已经开启两步验证",40902,409);
      const challengeId = randomBytes(24).toString("hex"), expiresAt = Date.now() + 10 * 60_000;
      getDb().prepare("DELETE FROM app_security_challenges WHERE expires_at<=? OR user_id=?").run(Date.now(),grant.user_id);
      getDb().prepare("INSERT INTO totp_setup(user_id,secret,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at").run(grant.user_id, encryptSecret(secret), expiresAt);
      const pending = getDb().prepare("SELECT secret FROM totp_setup WHERE user_id=?").get(grant.user_id) as {secret:string};
      getDb().prepare("INSERT INTO app_security_challenges VALUES(?,?,?,?,?)").run(challengeId,grant.user_id,grant.id,appTokenHash(pending.secret),expiresAt);
      logSecurityEvent(request,grant.user_id,"app.totp.setup","temporary challenge issued");
      return { challengeId, secret, otpauthUrl, qrPng, expiresAt };
    }).immediate();
  }
  return getDb().transaction(() => {
    const grant = securityGrant(request, true), db = getDb();
    if (action === "confirm") {
      stepUp(grant.user_id,body,false);
      const pending = db.prepare("SELECT c.secret_hash,s.secret,c.expires_at FROM app_security_challenges c JOIN totp_setup s ON s.user_id=c.user_id WHERE c.id=? AND c.user_id=? AND c.grant_id=? AND s.expires_at>?").get(body.challengeId || "",grant.user_id,grant.id,Date.now()) as {secret_hash:string;secret:string;expires_at:number}|undefined;
      if (!pending || pending.expires_at<=Date.now() || appTokenHash(pending.secret)!==pending.secret_hash) throw new SecurityError("设置已过期，请重新开始",40902,409);
      if (body.name !== undefined && (!body.name.trim() || body.name.length>64 || /[\x00-\x1f\x7f]/.test(body.name))) throw new SecurityError("名称需为1至64个字符");
      if (userTotpEnabled(grant.user_id)) throw new SecurityError("已经开启两步验证",40902,409);
      const result = enableTotp(grant.user_id,body.code || "",body.name || "身份验证应用");
      if (!result.ok) throw new SecurityError("验证码错误或设置已过期",40104,403);
      db.prepare("DELETE FROM app_security_challenges WHERE user_id=?").run(grant.user_id);
      deleteOtherSessions(grant.user_id,null);
      logSecurityEvent(request,grant.user_id,"app.totp.enabled","all sessions and grants revoked");
      return {ok:true,enabled:true,backupCodes:result.backupCodes,reauthenticationRequired:true};
    }
    if (!userTotpEnabled(grant.user_id)) throw new SecurityError("尚未开启两步验证",40902,409);
    stepUp(grant.user_id,body);
    if (action === "disable") {
      clearTotp(grant.user_id); deleteOtherSessions(grant.user_id,null);
      db.prepare("DELETE FROM app_security_challenges WHERE user_id=?").run(grant.user_id);
      logSecurityEvent(request,grant.user_id,"app.totp.disabled","all sessions and grants revoked");
      return {ok:true,enabled:false,reauthenticationRequired:true};
    }
    const backupCodes = generateBackupCodes();
    db.prepare("UPDATE users SET totp_backup_codes=? WHERE id=?").run(JSON.stringify(backupCodes.map(hashBackupCode)),grant.user_id);
    logSecurityEvent(request,grant.user_id,"app.totp.backup_codes","backup codes replaced");
    return {ok:true,backupCodes,reauthenticationRequired:connectionRequiresReauthentication(request)};
  }).immediate();
}
export function readPasskeys(request: Request) {
  const grant = securityGrant(request);
  return { keys: listPasskeys(grant.user_id).map(row => ({id:row.id,name:row.name,rpID:row.rp_id,createdAt:row.created_at,lastUsedAt:row.last_used_at,backedUp:!!row.backed_up})), registration: nativePasskeyRegistration() };
}
export async function removePasskey(request: Request) {
  const initial = securityGrant(request,true); budget(request,initial.user_id,"passkey-remove");
  const body = await securityBody(request,["id","currentPassword","code"]);
  return getDb().transaction(() => {
    const grant = securityGrant(request,true), db=getDb();
    if (!body.id || !db.prepare("SELECT 1 FROM passkeys WHERE id=? AND user_id=?").get(body.id,grant.user_id)) throw new SecurityError("通行密钥不存在",40401,404);
    stepUp(grant.user_id,body);
    db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(body.id,grant.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND (passkey_id=? OR auth_method='legacy')").run(grant.user_id,body.id);
    db.prepare("UPDATE app_grants SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND passkey_id=?").run(Date.now(),grant.user_id,body.id);
    logSecurityEvent(request,grant.user_id,"app.passkey.removed","credential and derived sessions revoked");
    return {ok:true,reauthenticationRequired:connectionRequiresReauthentication(request)};
  }).immediate();
}
type WebDevice = {token:string;expires_at:number;authenticated_at:number};
const webDeviceId = (token:string) => "web_" + appTokenHash(`security-device:${token}`);
export function readDevices(request: Request) {
  const grant = securityGrant(request);
  const web = (getDb().prepare("SELECT token,expires_at,authenticated_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY expires_at DESC").all(grant.user_id,Date.now()) as WebDevice[])
    .map(s => ({id:webDeviceId(s.token),kind:"web",name:"网页登录",createdAt:s.authenticated_at || null,lastUsedAt:null,expiresAt:s.expires_at,current:false}));
  return {devices:[...listAppDevices(grant.user_id).map(g=>({...g,kind:"app",current:g.id===grant.id})),...web]};
}
export async function removeDevice(request: Request) {
  const initial = securityGrant(request,true); budget(request,initial.user_id,"device-remove");
  const body = await securityBody(request,["id","currentPassword","code"]);
  return getDb().transaction(() => {
    const grant = securityGrant(request,true), db=getDb();
    const web = (db.prepare("SELECT token FROM sessions WHERE user_id=? AND expires_at>?").all(grant.user_id,Date.now()) as {token:string}[]).find(s=>webDeviceId(s.token)===body.id);
    const app = listAppDevices(grant.user_id).find(g=>g.id===body.id);
    if (!web && !app) throw new SecurityError("登录设备不存在",40401,404);
    stepUp(grant.user_id,body);
    if (web) db.prepare("DELETE FROM sessions WHERE token=? AND user_id=?").run(web.token,grant.user_id);
    if (app) revokeAppGrant(app.id,grant.user_id);
    logSecurityEvent(request,grant.user_id,"app.device.revoked",web?"web session revoked":"app grant revoked");
    return {revoked:true,reauthenticationRequired:connectionRequiresReauthentication(request)};
  }).immediate();
}
export function readEmailVerification(request: Request) {
  const grant = securityGrant(request), verified=emailVerified(grant.user_id,grant.email);
  return {email:grant.email,verified,canRequest:!!grant.email && !verified && grant.scope.split(" ").includes("security.write") && mailConfigured() && !!verificationOrigin(request)};
}
export async function requestEmailVerification(request: Request) {
  const initial=securityGrant(request,true); budget(request,initial.user_id,"email-request");
  if (!rateLimit(`verify-email-ip:${clientIp(request)}`,10,15*60_000) || !rateLimit(`verify-email-user:${initial.user_id}`,5,15*60_000) || !rateLimit(`verify-email-day:${initial.user_id}`,10,24*60*60_000)) throw new SecurityError("发送过于频繁",42901,429);
  await securityBody(request,[]);
  const origin=verificationOrigin(request);
  let permit: MailPermit|undefined;
  const issued=getDb().transaction(()=>{
    const grant=securityGrant(request,true);
    if (!grant.email) throw new SecurityError("请先绑定邮箱");
    if (emailVerified(grant.user_id,grant.email)) return null;
    if (!origin || !mailConfigured()) throw new SecurityError("邮件服务或验证链接尚未配置",50301,503);
    try { return issueEmailVerification(grant.user_id,email=>{permit=reserveMailAttempt(email,"verification");}); }
    catch(error) { if(error instanceof MailBudgetError) throw new SecurityError(error.message,42901,429); throw error; }
  }).immediate();
  if (!issued) {
    const grant=securityGrant(request,true);
    if(emailVerified(grant.user_id,grant.email)) return {ok:true,verified:true};
    throw new SecurityError("请在60秒后重试",42901,429);
  }
  try { await sendEmailVerification(issued.email,`${origin}/verify-email?token=${encodeURIComponent(issued.token)}`,permit,issued.token); }
  catch { revokeEmailVerification(issued.token); throw new SecurityError("邮件发送失败，请稍后重试",50002,502); }
  logSecurityEvent(request,initial.user_id,"app.email_verification.requested","verification sent; not yet verified");
  return {ok:true,verified:false,retryAfter:60};
}
export async function verifyEmail(request: Request) {
  const initial=securityGrant(request,true); budget(request,initial.user_id,"email-confirm");
  const body=await securityBody(request,["token"]);
  return getDb().transaction(()=>{
    const grant=securityGrant(request,true);
    if (!confirmEmailVerification(body.token || "",grant.user_id)) throw new SecurityError("验证凭证错误或已失效",40003,400);
    logSecurityEvent(request,grant.user_id,"app.email_verified","email ownership verified");
    // Return public identity through the same serializer used by /auth/me.
    return {ok:true,verified:true,user:appProfile(request,getAuthUser(request)!)};
  }).immediate();
}
