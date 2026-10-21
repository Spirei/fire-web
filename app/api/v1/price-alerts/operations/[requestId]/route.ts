import { priceAlertsResponse } from "@/lib/priceAlertsApi";
export const dynamic = "force-dynamic";
export async function GET(request:Request, context:{params:Promise<{requestId:string}>}) {
  const {requestId}=await context.params;
  return priceAlertsResponse(request,"operation",requestId);
}
export async function POST(request:Request, context:{params:Promise<{requestId:string}>}) {
  const {requestId}=await context.params;
  return priceAlertsResponse(request,"operation",requestId);
}
