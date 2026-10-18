import { personalProfileResponse } from "@/lib/personalProfileApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{requestId:string}>}){return appV2Response(request,()=>personalProfileResponse(request,"background",2,context.params));}
export async function POST(request:Request,context:{params:Promise<{requestId:string}>}){return appV2Response(request,()=>personalProfileResponse(request,"background",2,context.params));}
