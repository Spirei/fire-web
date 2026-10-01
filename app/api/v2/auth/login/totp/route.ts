import { appV2Response } from "@/lib/appApiV2";
import { nativeLoginFactor, nativeLoginResponse } from "@/lib/appNativeLogin";
export const dynamic="force-dynamic";
export async function POST(request:Request) {return appV2Response(request,()=>nativeLoginResponse(()=>nativeLoginFactor(request)));}
