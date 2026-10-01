import * as legacy from "@/app/api/v1/auth/password-reset/confirm/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function POST(request:Request) { return appV2Response(request,()=>legacy.POST(request)); }
