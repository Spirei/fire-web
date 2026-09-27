import { NextResponse } from "next/server";
import { isTrustedMutationRequest } from "@/lib/auth";
import { confirmEmailVerification } from "@/lib/emailVerification";
import { clientIp,rateLimit,rateLimitGlobal } from "@/lib/rateLimit";
import { readJsonBody } from "@/lib/requestBody";
export async function POST(request:Request) {
  if(!isTrustedMutationRequest(request)) return NextResponse.json({error:"请求来源不受信任"},{status:403});
  if(!rateLimit(`verify-email-confirm:${clientIp(request)}`,20,15*60_000)||!rateLimitGlobal("verify-email-confirm",200,15*60_000)) return NextResponse.json({error:"尝试过于频繁，请稍后再试"},{status:429});
  const body=await readJsonBody(request,8*1024).catch(()=>null);
  if(!confirmEmailVerification(typeof body?.token==="string"?body.token:"")) return NextResponse.json({error:"链接已失效，请重新发送确认邮件"},{status:400});
  return NextResponse.json({ok:true},{headers:{"Cache-Control":"no-store"}});
}
