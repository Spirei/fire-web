import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, isTrustedMutationRequest } from "@/lib/auth";
import { readMailTemplates, saveMailTemplate } from "@/lib/mailTemplates";
import { readJsonBody } from "@/lib/requestBody";
export const dynamic="force-dynamic";
const response=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{"Cache-Control":"private, no-store"}});
export async function GET(request:Request){
  if(!isAdmin(getAuthUser(request)))return response({error:"需要管理员权限"},403);
  return response({templates:readMailTemplates()});
}
export async function PUT(request:Request){
  if(!isTrustedMutationRequest(request) || !isAdmin(getAuthUser(request)))return response({error:"需要管理员权限"},403);
  try{
    const body=await readJsonBody(request,16*1024);
    // Recheck after reading the body; revoked or demoted sessions cannot save.
    if(!isAdmin(getAuthUser(request)))return response({error:"登录已失效"},403);
    return response({templates:saveMailTemplate(body)});
  }catch(error){return response({error:error instanceof Error?error.message:"模板保存失败"},400);}
}
