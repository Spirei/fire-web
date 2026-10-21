import { priceAlertsResponse } from "@/lib/priceAlertsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export function POST(request:Request) {
  return appV2Response(request,()=>priceAlertsResponse(request,"telegram"));
}
