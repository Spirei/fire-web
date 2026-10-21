import { priceAlertsResponse } from "@/lib/priceAlertsApi";
export const dynamic = "force-dynamic";
export function POST(request:Request) {
  return priceAlertsResponse(request,"telegram");
}
