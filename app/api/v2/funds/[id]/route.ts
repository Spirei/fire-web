import * as legacy from "@/app/api/v1/funds/[id]/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function DELETE(request:Request, context: {params:Promise<{id:string}>}) { return appV2Response(request,()=>legacy.DELETE(request,context)); }
