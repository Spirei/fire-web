import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { sendTestEmail } from "@/lib/mail";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  if (!user.email) return NextResponse.json({ error: "请先在个人信息中绑定邮箱" }, { status: 400 });
  if (!rateLimit(`mail-test:${clientIp(request)}:${user.id}`, 3, 10 * 60 * 1000)) return NextResponse.json({ error: "测试过于频繁，请稍后再试" }, { status: 429 });
  try {
    const body = await request.json().catch(() => ({}));
    const port = Number(body.smtpPort);
    const config = {
      host: String(body.smtpHost || "").trim().slice(0, 255),
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 587,
      secure: body.smtpSecure === true,
      user: String(body.smtpUser || "").trim().slice(0, 320),
      password: String(body.smtpPassword || "").slice(0, 1024),
      fromName: String(body.smtpFromName || "").trim().slice(0, 120),
      fromEmail: String(body.smtpFromEmail || "").trim().slice(0, 320)
    };
    if (!config.host || !config.fromEmail) return NextResponse.json({ error: "请填写 SMTP 主机和发件邮箱" }, { status: 400 });
    await sendTestEmail(user.email, config);
    return NextResponse.json({ ok: true, email: user.email });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "发送失败" }, { status: 502 });
  }
}
