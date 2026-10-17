import { brokerStatementsResponse } from "@/lib/brokerStatementsApi";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerStatementsResponse(request,"preview",context.params);}
