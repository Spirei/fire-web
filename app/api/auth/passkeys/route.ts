import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { applySessionCookie, createSession, findUserById, getAuthUser, getUserByToken, getSessionToken, SESSION_COOKIE, sessionCookieMaxAge } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { consumeTotpFactor, userTotpEnabled } from "@/lib/totpAuth";
import { getDb } from "@/lib/db";
import { assertPasskeyOrigin, consumePasskeyChallenge, issuePasskeyChallenge, listPasskeys, passkeyConfig, PASSKEY_COOKIE, type PasskeyRow } from "@/lib/passkeys";
import { readJsonBody } from "@/lib/requestBody";
import { rateLimit, clientIp, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store, private" } });
function requireTopLevel(response: RegistrationResponseJSON | AuthenticationResponseJSON) {
  const data = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
  if (data.crossOrigin || data.topOrigin) throw new Error("请直接打开站点完成通行密钥验证");
}
function stepUp(userId: string, body: Record<string, any>) {
  const user = findUserById(userId);
  if (!user || !verifyPassword(String(body.password ?? ""), user.password_hash)) throw new Error("当前密码不正确");
  if (userTotpEnabled(userId) && !consumeTotpFactor(userId, String(body.code ?? ""))) throw new Error("二次验证码或备用码不正确");
  return user;
}
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return json({ error: "未登录" }, 401);
  return json({ keys: listPasskeys(user.id).map(row => ({ id: row.id, name: row.name, rpID: row.rp_id, createdAt: row.created_at, lastUsedAt: row.last_used_at, backedUp: !!row.backed_up })), totpEnabled: userTotpEnabled(user.id) });
}
export async function POST(request: Request) {
  if (!rateLimit(`passkey:${clientIp(request)}`, 100, 900000) || !rateLimitGlobal("passkey", 500, 900000)) return json({ error: "尝试过于频繁，请稍后再试" }, 429);
  const body = await readJsonBody(request, 32768).catch(() => null);
  if (!body) return json({ error: "无效的请求" }, 400);
  const config = passkeyConfig();
  try {
    assertPasskeyOrigin(request, config);
    const action = body.action;
    if (action === "register-options") {
      const me = getAuthUser(request);
      if (!me) return json({ error: "未登录" }, 401);
      if (!rateLimit(`passkey-enroll:${me.id}`, 10, 900000)) return json({ error: "尝试过于频繁，请稍后再试" }, 429);
      const user = stepUp(me.id, body);
      const existing = listPasskeys(me.id);
      if (existing.length >= 20) throw new Error("最多添加 20 个通行密钥，请先移除不用的密钥");
      const userHandle = existing.find(key => key.rp_id === config.rpID)?.user_handle || randomBytes(32).toString("base64url");
      const options = await generateRegistrationOptions({
        rpName: config.name, rpID: config.rpID, userName: user.username,
        userDisplayName: user.nickname || user.username, userID: new Uint8Array(Buffer.from(userHandle, "base64url")),
        attestationType: "none", supportedAlgorithmIDs: [-7, -257],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: existing.filter(key => key.rp_id === config.rpID).map(key => ({ id: key.id, transports: JSON.parse(key.transports) })),
        extensions: { credProps: true }
      });
      // userHandle 与 challenge 一同保存，校验结束前不接受客户端修改用户归属。
      const issued = issuePasskeyChallenge(request, "register", JSON.stringify({ challenge: options.challenge, userHandle }), config, me.id, user.password_hash);
      const response = json({ options, requestId: issued.id });
      response.cookies.set(PASSKEY_COOKIE, issued.nonce, { httpOnly: true, sameSite: "strict", secure: config.origin.startsWith("https:"), path: "/api/auth/passkeys", maxAge: 300 });
      return response;
    }
    if (action === "register-verify") {
      const me = getAuthUser(request);
      if (!me) return json({ error: "未登录" }, 401);
      const pending = consumePasskeyChallenge(request, String(body.requestId || ""), "register", config, me.id);
      const { challenge, userHandle } = JSON.parse(pending.challenge);
      requireTopLevel(body.response);
      if (body.response?.clientExtensionResults?.credProps?.rk === false) throw new Error("请选择支持保存通行密钥的设备或密码管理器");
      const result = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
      if (!result.verified || !result.registrationInfo) throw new Error("通行密钥验证失败");
      const info = result.registrationInfo;
      getDb().transaction(() => {
        if (!getUserByToken(getSessionToken(request)) || findUserById(me.id)?.password_hash !== pending.password_hash || passkeyConfig().revision !== config.revision) throw new Error("登录或站点配置已变化，请重新绑定");
        if (listPasskeys(me.id).length >= 20) throw new Error("通行密钥数量已达上限");
        getDb().prepare("INSERT INTO passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(info.credential.id, me.id, userHandle, config.rpID, Buffer.from(info.credential.publicKey), info.credential.counter, JSON.stringify(info.credential.transports || []), String(body.name || "通行密钥").trim().slice(0, 64) || "通行密钥", Number(info.credentialBackedUp), Date.now());
      })();
      logSecurityEvent(request, me.id, "auth.passkey.added", "通行密钥已添加");
      return json({ ok: true });
    }
    if (action === "login-options") {
      const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: "required" });
      const issued = issuePasskeyChallenge(request, "login", options.challenge, config);
      const response = json({ options, requestId: issued.id });
      response.cookies.set(PASSKEY_COOKIE, issued.nonce, { httpOnly: true, sameSite: "strict", secure: config.origin.startsWith("https:"), path: "/api/auth/passkeys", maxAge: 300 });
      return response;
    }
    if (action === "login-verify") {
      const pending = consumePasskeyChallenge(request, String(body.requestId || ""), "login", config);
      const assertion = body.response as AuthenticationResponseJSON;
      requireTopLevel(assertion);
      const key = getDb().prepare("SELECT * FROM passkeys WHERE id=? AND rp_id=?").get(String(assertion?.id || ""), config.rpID) as PasskeyRow | undefined;
      if (!key || assertion.response?.userHandle !== key.user_handle) throw new Error("通行密钥验证失败");
      const passwordHash = findUserById(key.user_id)?.password_hash;
      const result = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: pending.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true,
        credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) } });
      if (!result.verified) throw new Error("通行密钥验证失败");
      const token = getDb().transaction(() => {
        if (!passwordHash || findUserById(key.user_id)?.password_hash !== passwordHash || passkeyConfig().revision !== config.revision) throw new Error("账号或站点配置已变化，请重新登录");
        const updated = getDb().prepare("UPDATE passkeys SET counter=?,last_used_at=?,backed_up=? WHERE id=? AND counter=?")
          .run(result.authenticationInfo.newCounter, Date.now(), Number(result.authenticationInfo.credentialBackedUp), key.id, key.counter);
        if (!updated.changes) throw new Error("通行密钥已撤销或已使用，请重试");
        return createSession(key.user_id);
      })();
      logSecurityEvent(request, key.user_id, "auth.passkey.login", "通行密钥登录成功");
      const response = json({ ok: true });
      applySessionCookie(response, token, request);
      // HTTPS 由经过配置并已核验的 Origin 决定，不依赖代理头。
      response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.origin.startsWith("https:"), path: "/", maxAge: sessionCookieMaxAge() });
      return response;
    }
    return json({ error: "不支持的操作" }, 400);
  } catch (error) {
    logSecurityEvent(request, "", "auth.passkey.rejected", String(body.action || "invalid").slice(0, 32));
    // 不向浏览器暴露 CBOR、签名校验或数据库内部错误。
    const message = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "通行密钥验证失败，请重新尝试";
    return json({ error: message }, 400);
  }
}
export async function PATCH(request: Request) { return manage(request, false); }
export async function DELETE(request: Request) { return manage(request, true); }
async function manage(request: Request, remove: boolean) {
  const me = getAuthUser(request);
  if (!me) return json({ error: "未登录" }, 401);
  if (!rateLimit(`passkey-manage:${me.id}`, 15, 900000)) return json({ error: "操作过于频繁，请稍后再试" }, 429);
  const body = await readJsonBody(request, 8192).catch(() => null);
  if (!body) return json({ error: "无效的请求" }, 400);
  try {
    if (remove) stepUp(me.id, body);
    const id = String(body.id || "");
    const name = String(body.name || "").trim();
    if (!remove && (!name || name.length > 64)) throw new Error("名称需为 1–64 个字符");
    const result = remove ? getDb().prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(id, me.id)
      : getDb().prepare("UPDATE passkeys SET name=? WHERE id=? AND user_id=?").run(name, id, me.id);
    if (!result.changes) return json({ error: "通行密钥不存在" }, 404);
    logSecurityEvent(request, me.id, remove ? "auth.passkey.removed" : "auth.passkey.renamed", "通行密钥管理");
    return json({ ok: true });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "验证失败" }, 403); }
}
