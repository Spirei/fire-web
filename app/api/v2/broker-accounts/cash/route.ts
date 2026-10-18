import { brokerCashResponse } from "@/lib/brokerCashApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
export const GET=(request:Request)=>appV2Response(request,()=>brokerCashResponse(request,"summary",undefined,2));
