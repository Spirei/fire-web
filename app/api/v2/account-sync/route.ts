import { appV2Response } from "@/lib/appApiV2";
import { accountSyncResponse } from "@/lib/appSync";
export const dynamic="force-dynamic";
export async function GET(request:Request) {return appV2Response(request,()=>accountSyncResponse(request));}
