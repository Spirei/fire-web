import { priceAlertsResponse } from "@/lib/priceAlertsApi";
export const dynamic = "force-dynamic";
export function GET(request:Request) {
  return priceAlertsResponse(request,"snapshot");
}
