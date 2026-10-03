import * as legacy from "@/app/api/v1/records/[id]/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request, context: {params:Promise<{id:string}>}) { return appV2Response(request,()=>legacy.GET(request,context)); }
export async function PUT(request:Request, context: {params:Promise<{id:string}>}) { return appV2Response(request,()=>legacy.PUT(request,context)); }
export async function DELETE(request:Request, context: {params:Promise<{id:string}>}) { return appV2Response(request,()=>legacy.DELETE(request,context)); }
