import { brokerCashResponse } from "@/lib/brokerCashApi";
export const dynamic="force-dynamic";
export const GET=(request:Request,context:{params:Promise<{accountId:string}>})=>brokerCashResponse(request,"entries",context.params);
