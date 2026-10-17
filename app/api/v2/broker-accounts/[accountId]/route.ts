import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return appV2Response(request,()=>brokerAccountsResponse(request,"account",2,context.params));}
export async function PUT(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return appV2Response(request,()=>brokerAccountsResponse(request,"account",2,context.params));}
export async function DELETE(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return appV2Response(request,()=>brokerAccountsResponse(request,"account",2,context.params));}
