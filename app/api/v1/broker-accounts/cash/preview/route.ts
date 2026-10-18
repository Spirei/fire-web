import { brokerCashResponse } from "@/lib/brokerCashApi";
export const dynamic="force-dynamic";
export const POST=(request:Request)=>brokerCashResponse(request,"preview");
