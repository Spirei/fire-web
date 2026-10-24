import { appV2Response } from "@/lib/appApiV2";
import { appStateResponse } from "@/lib/appSync";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{requestId:string}>}) {const {requestId}=await params;return appV2Response(request,()=>appStateResponse(request,requestId));}
