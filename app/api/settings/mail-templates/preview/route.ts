import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { renderMailTemplate } from "@/lib/mailTemplates";
import { validateMailTemplate } from "@/lib/mailTemplateModel";
import { readJsonBody } from "@/lib/requestBody";
export const dynamic="force-dynamic";
export async function POST(request:Request){
  const headers={"Cache-Control":"private, no-store"};
  if(!isTrustedMutationRequest(request) || !isAdmin(getAuthUser(request)))return NextResponse.json({error:"需要管理员权限"},{status:403,headers});
  try{
    const body=await readJsonBody(request,16*1024),template=validateMailTemplate(body);
    if(!isAdmin(getAuthUser(request)))return NextResponse.json({error:"登录已失效"},{status:403,headers});
    // Preview is deterministic and never creates a credential, sends mail, or saves drafts.
    return NextResponse.json(renderMailTemplate(template,{email:"client@example.com",siteName:"Alcor",name:"客户",minutes:30,stockName:"苹果",stockCode:"AAPL",market:"US",currentPrice:"340.35",targetPrice:"340.00",currency:"USD",direction:"涨至",session:"盘后",quoteTime:"2026-10-21 16:05:00 美东",triggerTime:"10/21 16:05 美东",code:"593255",url:new URL("/verify-email?preview=1",request.url).href,nativeToken:template.kind==="link"?"PREVIEW-ONLY-NOT-A-REAL-CREDENTIAL":undefined},"/api/system-assets/mail-banner"),{headers});
  }catch{return NextResponse.json({error:"模板格式无效"},{status:400,headers});}
}
