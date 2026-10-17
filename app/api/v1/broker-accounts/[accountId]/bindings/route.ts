import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerAccountsResponse(request,"bindings",1,context.params);}
