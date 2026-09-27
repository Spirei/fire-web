import { NextResponse } from "next/server";
import { findUserByLogin, getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { sendPasswordResetEmail, mailConfigured } from "@/lib/mail";
import { issuePasswordResetToken, PASSWORD_RESET_MINUTES, revokePasswordResetToken } from "@/lib/passwordReset";
import { getSiteSettings } from "@/lib/settings";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/requestBody";

const GENERIC_MESSAGE = "如果账号存在且已绑定邮箱，重置邮件会在几分钟内送达。";

function publicOrigin(request: Request) {
  const configured = getSiteSettings().domain.trim();
  if (/^https?:\/\//i.test(configured)) {
    try { return new URL(configured).origin; } catch { return ""; }
  }
  if (configured && configured !== "localhost:3000") {
    const local = /^(localhost|127\.0\.0\.1|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(configured);
    return `${local ? "http" : "https"}://${configured.replace(/^\/+|\/+$/g, "")}`;
  }
  if (process.env.NODE_ENV !== "production") {
    try { return new URL(request.url).origin; } catch { return ""; }
  }
  return "";
}

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  const ip = clientIp(request);
  if (!rateLimit(`password-reset-request:${ip}`, 5, 15 * 60 * 1000) || !rateLimitGlobal("password-reset-request", 80, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 8 * 1024).catch(() => null);
  const login = String(body?.login ?? "").trim().slice(0, 160);
  if (!login) return NextResponse.json({ error: "请输入用户名或邮箱" }, { status: 400 });

  const user = findUserByLogin(login);
  const origin = publicOrigin(request);
  const requester = getAuthUser(request);
  const selfRequest = Boolean(requester && user && requester.id === user.id);
  if (selfRequest && !user?.email) return NextResponse.json({ error: "请先在个人信息中绑定邮箱" }, { status: 400 });
  if (selfRequest && (!origin || !mailConfigured())) return NextResponse.json({ error: "邮件服务尚未配置，请先在设置中完成 SMTP 配置" }, { status: 503 });
  if (user?.email && origin && mailConfigured()) {
    const issued = issuePasswordResetToken(user.id);
    try {
      const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(issued.token)}`;
      await sendPasswordResetEmail({ to: user.email, name: user.nickname || user.username, resetUrl, minutes: PASSWORD_RESET_MINUTES });
    } catch (error) {
      revokePasswordResetToken(issued.token);
      console.error("password reset email failed", error instanceof Error ? error.message : error);
      if (selfRequest) return NextResponse.json({ error: "邮件发送失败，请检查 SMTP 配置后重试" }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: true, message: GENERIC_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
}
