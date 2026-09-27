import { NextResponse } from "next/server";
import { isTrustedMutationRequest } from "@/lib/auth";
import { verifyPasswordResetCode, verifyPasswordRecoveryTotp } from "@/lib/passwordReset";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/requestBody";
export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  if (!rateLimit(`password-reset-verify:${clientIp(request)}`, 20, 15 * 60 * 1000) || !rateLimitGlobal("password-reset-verify", 200, 15 * 60 * 1000)) return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  const body = await readJsonBody(request, 8 * 1024).catch(() => null);
  const challenge = typeof body?.challenge === "string" ? body.challenge : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const verified = body?.method === "totp" ? verifyPasswordRecoveryTotp(challenge,code) : verifyPasswordResetCode(challenge, code);
  if (!verified) return NextResponse.json({ error: "验证码错误或已失效，请重新验证" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ ok: true, token: verified.token }, { headers: { "Cache-Control": "no-store" } });
}
