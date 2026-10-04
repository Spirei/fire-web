import { randomBytes } from "node:crypto";
import { APP_CLIENT_ID, APP_SCOPE, APP_SUPPORTED_SCOPES, appSecurityStamp, appTokenHash, authenticateAppAccess, createNativeAppGrant } from "./appAuth";
import { authenticateUser, getAuthUser } from "./auth";
import { appProfile } from "./appProfile";
import { DEFAULT_APP_DEVICE_NAME, normalizeAppDeviceName } from "./brand";
import { consumeTotpFactor } from "./totpAuth";
import { getDb } from "./db";
import { readJsonBody } from "./requestBody";
import { clientIp, loginIdentityKey, rateLimit, rateLimitGlobal } from "./rateLimit";
import { API_CODE, fail, ok } from "./api";
import { logSecurityEvent } from "./securityAudit";
import { decryptSecret } from "./secretStorage";

const CHALLENGE_SECONDS = 300, MAX_ATTEMPTS = 8;
type NativeUser = { id: string; password_hash: string; totp_enabled: number; totp_secret: string };
type Challenge = { user_id: string; client_id: string; origin: string; scope: string; device_name: string; security_stamp: string; source_grant_id: string | null; expires_at: number; attempts: number };
class LoginError extends Error {
  constructor(message: string, public code: number, public status: number) { super(message); }
}
class FactorRejected extends Error {}
const invalid = () => new LoginError("验证已失效，请重新开始", API_CODE.LOGIN_CHALLENGE_INVALID, 403);
function userById(id: string) {
  return getDb().prepare("SELECT id,password_hash,totp_enabled,totp_secret FROM users WHERE id=?").get(id) as NativeUser | undefined;
}
function budget(request: Request, factor = false) {
  const category = factor ? "login-totp" : "login";
  if (!rateLimit(`${category}:${clientIp(request)}`, factor ? 40 : 50, 15 * 60_000) || !rateLimitGlobal(category, factor ? 80 : 100, 15 * 60_000)) throw new LoginError("尝试过于频繁，请稍后再试",42901,429);
}
function accountBudget(login: string) {
  if (!rateLimit(`login-account:${loginIdentityKey(login)}`,20,15*60_000)) throw new LoginError("尝试过于频繁，请稍后再试",42901,429);
}
async function bodyFor(request: Request, fields: string[]) {
  const body = await readJsonBody(request,16*1024).catch(()=>null);
  if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(key=>!fields.includes(key)) || Object.values(body).some(value=>typeof value!=="string" || value.length>1024) || body.client_id!==APP_CLIENT_ID) throw new LoginError("请求参数无效",40002,400);
  return body as Record<string,string>;
}
function currentGrant(request: Request) {
  const token=request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new LoginError("需要有效的 App 连接",40101,401);
  const grant=authenticateAppAccess(token,request);
  if (!grant) throw new LoginError("连接已失效，请重新连接",40102,401);
  return grant;
}
function authenticated(request: Request, userId: string, scope: string, deviceName: string, sourceGrantId: string | null = null) {
  const tokens=createNativeAppGrant(userId,scope,deviceName,sourceGrantId || undefined);
  const url=new URL(request.url); url.pathname="/api/v2/auth/me"; url.search="";
  const headers=new Headers(request.headers); headers.delete("cookie"); headers.set("authorization",`Bearer ${tokens.access_token}`);
  const meRequest=new Request(url,{headers}), user=getAuthUser(meRequest);
  if (!user) throw new Error("New grant identity unavailable");
  logSecurityEvent(request,userId,sourceGrantId?"app_permissions_issued":"app_native_login_success",JSON.stringify({grantId:tokens.grant_id,scope:tokens.scope}));
  return {status:"authenticated" as const,apiVersion:2,...tokens,user:appProfile(meRequest,user),...(sourceGrantId?{replaces_grant_id:sourceGrantId}:{})};
}
function challenge(request: Request, user: NativeUser, scope: string, deviceName: string, sourceGrantId: string | null = null) {
  const db=getDb(), now=Date.now(), token="flc_"+randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM app_login_challenges WHERE expires_at<=?").run(now);
  const old=db.prepare("SELECT token_hash FROM app_login_challenges WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 7").all(user.id) as {token_hash:string}[];
  for (const row of old) db.prepare("DELETE FROM app_login_challenges WHERE token_hash=?").run(row.token_hash);
  db.prepare("INSERT INTO app_login_challenges(token_hash,user_id,client_id,origin,scope,device_name,security_stamp,source_grant_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(appTokenHash(token),user.id,APP_CLIENT_ID,new URL(request.url).origin,scope,deviceName,appSecurityStamp(user),sourceGrantId,now+CHALLENGE_SECONDS*1000,now);
  return {status:"requires_2fa" as const,apiVersion:2,purpose:sourceGrantId?"permissions":"login",challenge_token:token,expires_in:CHALLENGE_SECONDS,factors:["totp","backup_code"]};
}
function afterPassword(request: Request, user: NativeUser, scope: string, deviceName: string, sourceGrantId: string | null = null) {
  return user.totp_enabled ? challenge(request,user,scope,deviceName,sourceGrantId) : authenticated(request,user.id,scope,deviceName,sourceGrantId);
}
function preserveFactorMigration(user: NativeUser) {
  const current=userById(user.id)!;
  if (current.totp_secret===user.totp_secret) return;
  // The shared factor reader encrypts legacy secrets. This is representation-only:
  // keep existing grants/challenges bound to the same credential, without reviving
  // stamps from any earlier password/factor state or changing scope/revocation.
  if (user.totp_secret.startsWith("enc:v1:") || current.password_hash!==user.password_hash || current.totp_enabled!==user.totp_enabled || !current.totp_secret.startsWith("enc:v1:") || !decryptSecret(user.totp_secret) || decryptSecret(current.totp_secret)!==decryptSecret(user.totp_secret)) throw new Error("Unexpected factor state change");
  const db=getDb(), before=appSecurityStamp(user), after=appSecurityStamp(current);
  db.prepare("UPDATE app_grants SET security_stamp=? WHERE user_id=? AND security_stamp=?").run(after,user.id,before);
  db.prepare("UPDATE app_login_challenges SET security_stamp=? WHERE user_id=? AND security_stamp=?").run(after,user.id,before);
}
export async function nativeLogin(request: Request) {
  budget(request);
  const body=await bodyFor(request,["client_id","username","password","device_name"]), username=(body.username || "").trim(), password=body.password || "";
  if (!username || !password || username.length>254 || password.length>128) throw new LoginError("用户名或密码错误",40103,403);
  if (body.device_name!==undefined && (body.device_name.length>64 || /[\x00-\x1f\x7f]/.test(body.device_name))) throw new LoginError("设备名称无效",40002,400);
  accountBudget(username);
  return getDb().transaction(()=>{
    const verified=authenticateUser(username,password);
    if (!verified) throw new LoginError("用户名或密码错误",40103,403);
    const user=userById(verified.id)!;
    return afterPassword(request,user,APP_SCOPE,normalizeAppDeviceName(body.device_name || "") || DEFAULT_APP_DEVICE_NAME);
  }).immediate();
}
export async function nativePermissions(request: Request) {
  budget(request);
  const body=await bodyFor(request,["client_id","scope","currentPassword"]);
  if (!body.scope || body.scope.length>512) throw new LoginError("请求权限无效",40002,400);
  const initial=currentGrant(request); accountBudget(initial.username);
  return getDb().transaction(()=>{
    const grant=currentGrant(request), requested=body.scope.split(" ").filter(Boolean), scopes=[...new Set([...grant.scope.split(" "),...requested])];
    if (!requested.length || requested.some(scope=>!APP_SUPPORTED_SCOPES.includes(scope)) || (scopes.includes("security.write")&&!scopes.includes("security.read")) || (scopes.includes("feed.write")&&!scopes.includes("feed.read")) || (scopes.includes("resources.write")&&!scopes.includes("resources.read"))) throw new LoginError("不支持的授权范围",40301,403);
    // Explicit scope consent uses the live connection; sensitive mutations verify credentials themselves.
    // Accept legacy currentPassword for compatibility, without storing or using it.
    return authenticated(request,grant.user_id,scopes.join(" "),grant.device_name,grant.id);
  }).immediate();
}
export async function nativeLoginFactor(request: Request) {
  budget(request,true);
  const body=await bodyFor(request,["client_id","challenge_token","code"]), token=body.challenge_token || "";
  if (!/^flc_[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const result=getDb().transaction(()=>{
    const db=getDb(), key=appTokenHash(token), row=db.prepare("SELECT * FROM app_login_challenges WHERE token_hash=?").get(key) as Challenge | undefined;
    if (!row || row.client_id!==APP_CLIENT_ID || row.origin!==new URL(request.url).origin) return invalid();
    if (row.expires_at<=Date.now()) {db.prepare("DELETE FROM app_login_challenges WHERE token_hash=?").run(key); return invalid();}
    const user=userById(row.user_id);
    if (!user || !user.totp_enabled || appSecurityStamp(user)!==row.security_stamp) {db.prepare("DELETE FROM app_login_challenges WHERE token_hash=?").run(key); return invalid();}
    if (row.source_grant_id) { const grant=currentGrant(request); if (grant.id!==row.source_grant_id || grant.user_id!==row.user_id) return invalid(); }
    if (row.attempts>=MAX_ATTEMPTS) {db.prepare("DELETE FROM app_login_challenges WHERE token_hash=?").run(key); return new LoginError("验证尝试次数过多，请重新开始",42901,429);}
    db.prepare("UPDATE app_login_challenges SET attempts=attempts+1 WHERE token_hash=?").run(key);
    try {
      // Roll back factor-side migrations on rejection, while retaining the challenge attempt.
      db.transaction(()=>{const code=(body.code || "").trim(); if (code.length<6 || code.length>32 || !consumeTotpFactor(user.id,code)) throw new FactorRejected();}).immediate();
    } catch (error) {
      if (!(error instanceof FactorRejected)) throw error;
      logSecurityEvent(request,user.id,"app_native_factor_rejected",JSON.stringify({purpose:row.source_grant_id?"permissions":"login",attempt:row.attempts+1}));
      if (row.attempts+1>=MAX_ATTEMPTS) {db.prepare("DELETE FROM app_login_challenges WHERE token_hash=?").run(key); return new LoginError("验证尝试次数过多，请重新开始",42901,429);}
      return new LoginError("验证码或备用码不正确",40104,403);
    }
    preserveFactorMigration(user);
    const response=authenticated(request,user.id,row.scope,row.device_name,row.source_grant_id);
    db.prepare("DELETE FROM app_login_challenges WHERE token_hash=?").run(key);
    return response;
  }).immediate();
  if (result instanceof LoginError) throw result;
  return result;
}
export async function nativeLoginResponse(operation:()=>unknown|Promise<unknown>) {
  try {return ok(await operation());}
  catch(error) {return fail(error instanceof LoginError?error.code:50001,error instanceof LoginError?error.message:"登录操作失败，请稍后重试",error instanceof LoginError?error.status:500);}
}
