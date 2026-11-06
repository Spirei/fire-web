import * as legacy from "@/app/api/v1/auth/mail-templates/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request){return appV2Response(request,()=>legacy.GET(request));}
