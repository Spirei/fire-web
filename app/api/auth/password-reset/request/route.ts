import { after, NextResponse } from "next/server";
import { findUserByLogin, getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { sendPasswordResetEmail, mailConfigured } from "@/lib/mail";
import { issuePasswordResetCode, issuePasswordRecoveryTotp, retainedTotpChallenge, newResetChallenge, retainedResetChallenge, PASSWORD_RESET_MINUTES, PASSWORD_RESET_COOLDOWN_SECONDS, revokePasswordResetCode } from "@/lib/passwordReset";
import { emailVerified } from "@/lib/emailVerification";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/requestBody";

const GENERIC_MESSAGE = "如果账号已绑定邮箱，验证码会发送至该邮箱。请检查收件箱与垃圾邮件。";
export async function POST(request: Request) {
  if (!isTrustedMutationRequest(request)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  if (!rateLimit(`password-reset-request:${clientIp(request)}`, 5, 15 * 60 * 1000) || !rateLimitGlobal("password-reset-request", 80, 15 * 60 * 1000)) return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429 });
  const body = await readJsonBody(request, 8 * 1024).catch(() => null);
  const login = typeof body?.login === "string" ? body.login.trim().slice(0, 160) : "";
  if (!login) return NextResponse.json({ error: "请输入用户名或邮箱" }, { status: 400 });
  const user = findUserByLogin(login);
  const requester = getAuthUser(request);
  const selfRequest = Boolean(requester && user && requester.id === user.id);
  if (body?.method === "totp") {
    const issued=user?issuePasswordRecoveryTotp(user.id):null;
    const challenge=issued?.challenge || (user?retainedTotpChallenge(user.id,body.challenge):null) || newResetChallenge();
    return NextResponse.json({ok:true,challenge,retryAfter:60,message:"请使用该账号已配置的验证器验证码或备用码。"},{headers:{"Cache-Control":"no-store"}});
  }
  if (selfRequest && !user?.email) return NextResponse.json({ error: "请先在个人信息中绑定邮箱" }, { status: 400 });
  if (selfRequest && user && !emailVerified(user.id,user.email)) return NextResponse.json({error:"请先在个人信息中验证邮箱"},{status:400});
  if (selfRequest && !mailConfigured()) return NextResponse.json({ error: "邮件服务尚未配置" }, { status: 503 });
  // 未知账号返回相同格式的随机 challenge，不暴露账号或邮箱是否存在。
  let challenge = newResetChallenge();
  if (user?.email && emailVerified(user.id,user.email) && mailConfigured()) {
    const issued = issuePasswordResetCode(user.id);
    if (issued) {
      challenge = issued.challenge;
      const deliver = async () => {
        try {
          await sendPasswordResetEmail({ to: issued.email, name: user.nickname || user.username, code: issued.code, minutes: PASSWORD_RESET_MINUTES });
          return true;
        } catch {
          revokePasswordResetCode(issued.challenge);
          console.error("password reset email delivery failed");
          return false;
        }
      };
      // 公开请求不等待 SMTP，避免发送耗时透露账号是否存在；Next 保证响应后任务运行。
      if (!selfRequest) after(deliver);
      else if (!await deliver()) return NextResponse.json({ error: "发送失败，请检查邮件服务后重试" }, { status: 502 });
    } else {
      challenge = retainedResetChallenge(user.id, body?.challenge) || challenge;
    }
  }
  return NextResponse.json({ ok: true, challenge, retryAfter: PASSWORD_RESET_COOLDOWN_SECONDS, message: GENERIC_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
}
