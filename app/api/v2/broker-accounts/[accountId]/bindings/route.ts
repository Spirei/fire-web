import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{accountId:string}>}) {return appV2Response(request,()=>brokerAccountsResponse(request,"bindings",2,context.params));}
