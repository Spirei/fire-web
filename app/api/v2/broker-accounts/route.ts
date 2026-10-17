import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export async function GET(request:Request) {return appV2Response(request,()=>brokerAccountsResponse(request,"list",2));}
export async function POST(request:Request) {return appV2Response(request,()=>brokerAccountsResponse(request,"list",2));}
