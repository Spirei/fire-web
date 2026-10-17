import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
export const dynamic="force-dynamic";
export async function GET(request:Request) {return brokerAccountsResponse(request,"list",1);}
export async function POST(request:Request) {return brokerAccountsResponse(request,"list",1);}
