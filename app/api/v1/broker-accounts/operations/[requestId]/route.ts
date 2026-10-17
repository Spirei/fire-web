import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
export const dynamic="force-dynamic";
export async function GET(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return brokerAccountsResponse(request,"operation",1,context.params);}
