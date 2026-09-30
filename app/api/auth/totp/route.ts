import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { deleteOtherSessions, findUserById, getAuthUser, getSessionToken, hasRecentAuthentication } from "@/lib/auth";
import { beginTotpSetup, disableTotp, enableTotp, userTotpEnabled } from "@/lib/totpAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";
import { verifyPassword } from "@/lib/password";
import { getDb } from "@/lib/db";

const NO_STORE = { headers: { "Cache-Control": "no-store, private" } };

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const enabled = userTotpEnabled(user.id);
  const metadata = getDb().prepare("SELECT totp_device_name FROM users WHERE id = ?").get(user.id) as { totp_device_name: string } | undefined;
  return NextResponse.json({ enabled, name: enabled ? metadata?.totp_device_name || "身份验证应用" : "" }, NO_STORE);
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`totp-setup:${user.id}`, 8, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  if (userTotpEnabled(user.id)) return NextResponse.json({ error: "已经开启二次验证" }, { status: 409 });
  // Inactive, expiring setup only; activation requires recent authentication or explicit step-up.
  const setup = await beginTotpSetup(user.id, user.username, "Alcor");
  logSecurityEvent(request, user.id, "auth.totp.setup", "开始绑定二次验证");
  return NextResponse.json({
    secret: setup.secret,
    otpauthUrl: setup.otpauthUrl,
    qrPng: setup.qrPng
  }, NO_STORE);
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`totp-enable:${user.id}`, 20, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 4 * 1024).catch(() => null);
  const row = findUserById(user.id);
  if (!row || (!hasRecentAuthentication(request, user.id) && !verifyPassword(String(body?.password ?? ""), row.password_hash))) {
    logSecurityEvent(request, user.id, "auth.totp.enable_rejected", "recent authentication or step-up required");
    return NextResponse.json({ error: "请重新验证身份", requiresReauthentication: true }, { status: 403 });
  }
  if (body?.name !== undefined && typeof body.name !== "string") return NextResponse.json({ error: "名称格式错误" }, { status: 400 });
  const result = enableTotp(user.id, String(body?.code ?? ""), body?.name ?? "身份验证应用");
  if (!result.ok) return NextResponse.json({ error: result.error || "验证失败" }, { status: 400 });
  deleteOtherSessions(user.id, getSessionToken(request));
  logSecurityEvent(request, user.id, "auth.totp.enabled", "二次验证已开启，其它会话已退出");
  return NextResponse.json({ ok: true, backupCodes: result.backupCodes }, NO_STORE);
}

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`totp-disable:${user.id}`, 20, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 4 * 1024).catch(() => null);
  const password = String(body?.password ?? "");
  const code = String(body?.code ?? "");
  const row = findUserById(user.id);
  const passwordOk = Boolean(row && verifyPassword(password, row.password_hash));
  const result = disableTotp(user.id, code, passwordOk);
  if (!result.ok) {
    logSecurityEvent(request, user.id, "auth.totp.disable_rejected", "关闭二次验证失败");
    return NextResponse.json({ error: result.error || "关闭失败" }, { status: 400 });
  }
  logSecurityEvent(request, user.id, "auth.totp.disabled", "二次验证已关闭");
  return NextResponse.json({ ok: true }, NO_STORE);
}
