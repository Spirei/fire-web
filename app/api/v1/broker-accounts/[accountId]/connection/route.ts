import { brokerStatementsResponse } from "@/lib/brokerStatementsApi";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerStatementsResponse(request,"connection",context.params);}
export async function PUT(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerStatementsResponse(request,"connection",context.params);}
export async function DELETE(request:Request,context:{params:Promise<{accountId:string}>}) {return brokerStatementsResponse(request,"connection",context.params);}
