import { NextResponse } from "next/server";
import { getAuthUser,isTrustedMutationRequest } from "@/lib/auth";
import { emailVerified,issueEmailVerification,revokeEmailVerification,verificationOrigin } from "@/lib/emailVerification";
import { mailConfigured,sendEmailVerification } from "@/lib/mail";
import { clientIp,rateLimit } from "@/lib/rateLimit";
import { MailBudgetError,reserveMailAttempt,type MailPermit } from "@/lib/mailBudget";
export async function POST(request:Request) {
  if(!isTrustedMutationRequest(request)) return NextResponse.json({error:"请求来源不受信任"},{status:403});
  const user=getAuthUser(request);
  if(!user) return NextResponse.json({error:"未登录"},{status:401});
  if(!user.email) return NextResponse.json({error:"请先保存邮箱"},{status:400});
  if(emailVerified(user.id,user.email)) return NextResponse.json({ok:true,verified:true});
  if(!rateLimit(`verify-email-ip:${clientIp(request)}`,10,15*60_000) || !rateLimit(`verify-email-user:${user.id}`,5,15*60_000) || !rateLimit(`verify-email-day:${user.id}`,10,24*60*60_000)) return NextResponse.json({error:"发送过于频繁，请稍后再试"},{status:429});
  const origin=verificationOrigin(request);
  if(!origin || !mailConfigured()) return NextResponse.json({error:"请先配置邮件服务与网站域名"},{status:503});
  let permit: MailPermit|undefined;
  let issued: ReturnType<typeof issueEmailVerification>;
  try { issued=issueEmailVerification(user.id,email=>{permit=reserveMailAttempt(email,"verification");}); }
  catch (error) { return NextResponse.json({error:error instanceof MailBudgetError ? error.message : "邮件服务暂不可用，请稍后重试"},{status:error instanceof MailBudgetError ? 429 : 503}); }
  if(!issued) return NextResponse.json({error:"请在 60 秒后重新发送"},{status:429});
  try { await sendEmailVerification(issued.email,`${origin}/verify-email?token=${encodeURIComponent(issued.token)}`,permit); }
  catch (error) { revokeEmailVerification(issued.token);return NextResponse.json({error:error instanceof MailBudgetError ? error.message : "发送失败，请稍后重试"},{status:error instanceof MailBudgetError ? 429 : 502}); }
  return NextResponse.json({ok:true,message:"确认链接已发送，请在邮箱中点击验证。"},{headers:{"Cache-Control":"no-store"}});
}
