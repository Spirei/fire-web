import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerAccountsResponse(request,"unbindings",1,context.params);}
