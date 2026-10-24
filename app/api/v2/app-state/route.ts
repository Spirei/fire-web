import { appV2Response } from "@/lib/appApiV2";
import { appStateResponse } from "@/lib/appSync";
export const dynamic="force-dynamic";
export async function GET(request:Request) {return appV2Response(request,()=>appStateResponse(request));}
export async function POST(request:Request) {return appV2Response(request,()=>appStateResponse(request));}
