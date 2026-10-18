import { brokerCashResponse } from "@/lib/brokerCashApi";
export const dynamic="force-dynamic";
export const GET=(request:Request)=>brokerCashResponse(request,"summary");
