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
    await sendTestEmail(user.email);
    return NextResponse.json({ ok: true, email: user.email });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "发送失败" }, { status: 502 });
  }
}
