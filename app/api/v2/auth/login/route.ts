import { appV2Response } from "@/lib/appApiV2";
import { nativeLogin, nativeLoginResponse } from "@/lib/appNativeLogin";
export const dynamic="force-dynamic";
export async function POST(request:Request) {return appV2Response(request,()=>nativeLoginResponse(()=>nativeLogin(request)));}
