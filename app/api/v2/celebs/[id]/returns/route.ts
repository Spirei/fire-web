import * as legacy from "@/app/api/v1/celebs/[id]/returns/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request, context: {params:Promise<{id:string}>}) { return appV2Response(request,()=>legacy.GET(request,context)); }
