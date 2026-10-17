import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
export const dynamic="force-dynamic";
export async function GET(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return brokerAccountsResponse(request,"account",1,context.params);}
export async function PUT(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return brokerAccountsResponse(request,"account",1,context.params);}
export async function DELETE(request:Request, context:{params:Promise<{accountId?:string;requestId?:string}>}) {return brokerAccountsResponse(request,"account",1,context.params);}
