import { NextResponse } from "next/server";
import { findUserByEmail, findUserById, getAuthUser, updateProfile } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`profile:${clientIp(request)}:${user.id}`, 30, 60 * 60 * 1000) || !rateLimitGlobal("profile", 300, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "无效的请求体" }, { status: 400 });

  const patch: { username?: string; email?: string; nickname?: string } = {};
  if (body.username !== undefined) {
    const username = String(body.username).trim();
    if (username.length < 3 || username.length > 20 || !USERNAME_RE.test(username)) {
      return NextResponse.json({ error: "用户名需为 3-20 位字母、数字、下划线或中文" }, { status: 400 });
    }
    patch.username = username;
  }
  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (email !== "" && !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "邮箱格式不正确" }, { status: 400 });
    }
    if (email !== "") {
      const existing = findUserByEmail(email);
      if (existing && existing.id !== user.id) {
        return NextResponse.json({ error: "该邮箱已被其他账号绑定" }, { status: 409 });
      }
    }
    if (email.toLowerCase() !== (user.email ?? "").trim().toLowerCase()) {
      const row = findUserById(user.id);
      if (!row || !verifyPassword(String(body.currentPassword ?? ""), row.password_hash)) {
        logSecurityEvent(request, user.id, "profile_email_rejected", "password verification failed");
        return NextResponse.json({ error: "修改邮箱需要验证当前密码" }, { status: 403 });
      }
    }
    patch.email = email;
  }
  if (body.nickname !== undefined) {
    const nickname = String(body.nickname).trim();
    if (nickname.length > 20) {
      return NextResponse.json({ error: "昵称最多 20 个字符" }, { status: 400 });
    }
    patch.nickname = nickname;
  }

  const updated = updateProfile(user.id, patch);
  if (!updated) return NextResponse.json({ error: "用户名已被使用" }, { status: 409 });
  logSecurityEvent(request, user.id, "profile_update", patch.email !== undefined ? "profile and email" : "profile");
  return NextResponse.json({ user: updated }, { headers: { "Cache-Control": "no-store" } });
}
