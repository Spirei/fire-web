import { brokerAccountsResponse } from "@/lib/brokerAccountsApi";
export const dynamic="force-dynamic";
export async function GET(request:Request) {return brokerAccountsResponse(request,"presets",1);}
