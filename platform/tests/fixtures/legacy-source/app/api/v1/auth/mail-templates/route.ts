import { ok, fail } from "@/lib/api";
import { assertAppOrigin } from "@/lib/appAuth";
import { readMailTemplates } from "@/lib/mailTemplates";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{assertAppOrigin(request);}catch{return fail(40301,"请求来源不受信任",403);}
  const response=ok({version:1,style:"alcor-brand-v1",banner_path:"/api/system-assets/mail-banner",templates:readMailTemplates()});
  response.headers.set("Cache-Control","no-store");return response;
}
