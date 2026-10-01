import * as legacy from "@/app/api/v1/watch-groups/[id]/icon/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function POST(request:Request, context: {params:Promise<{id:string}>}) { return appV2Response(request,()=>legacy.POST(request,context)); }
