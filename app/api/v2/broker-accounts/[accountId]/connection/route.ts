import { brokerStatementsResponse } from "@/lib/brokerStatementsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{accountId:string}>}) {return appV2Response(request,()=>brokerStatementsResponse(request,"connection",context.params));}
export async function PUT(request:Request,context:{params:Promise<{accountId:string}>}) {return appV2Response(request,()=>brokerStatementsResponse(request,"connection",context.params));}
export async function DELETE(request:Request,context:{params:Promise<{accountId:string}>}) {return appV2Response(request,()=>brokerStatementsResponse(request,"connection",context.params));}
