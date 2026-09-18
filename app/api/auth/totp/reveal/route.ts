import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { revealTotp } from "@/lib/totpAuth";
import { rateLimit } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`totp-reveal:${user.id}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 4 * 1024).catch(() => null);
  const result = await revealTotp(user.id, user.username, String(body?.code ?? ""), "Fire");
  if (!result.ok) {
    logSecurityEvent(request, user.id, "auth.totp.reveal_rejected", "查看二次验证密钥失败");
    return NextResponse.json({ error: result.error || "验证失败" }, { status: 400 });
  }
  logSecurityEvent(request, user.id, "auth.totp.revealed", "查看二次验证密钥以添加其他验证器");
  return NextResponse.json({
    secret: result.secret,
    otpauthUrl: result.otpauthUrl,
    qrPng: result.qrPng
  }, { headers: { "Cache-Control": "no-store, private" } });
}
