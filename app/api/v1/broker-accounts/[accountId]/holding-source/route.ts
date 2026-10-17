import { brokerStatementsResponse } from "@/lib/brokerStatementsApi";
export const dynamic="force-dynamic";
export async function PUT(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerStatementsResponse(request,"source",context.params);}
