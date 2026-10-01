import * as legacy from "@/app/api/v1/feed/[[...action]]/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
type Context={params:Promise<{action?:string[]}>};
export async function GET(request:Request,context:Context) { return appV2Response(request,()=>legacy.GET(request,context)); }
export async function POST(request:Request,context:Context) { return appV2Response(request,()=>legacy.POST(request,context)); }
export async function PUT(request:Request,context:Context) { return appV2Response(request,()=>legacy.PUT(request,context)); }
