import { priceAlertsResponse } from "@/lib/priceAlertsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export function GET(request:Request) {
  return appV2Response(request,()=>priceAlertsResponse(request,"snapshot"));
}
