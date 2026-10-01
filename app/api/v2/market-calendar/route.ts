import { appV2Response } from "@/lib/appApiV2";
import { marketCalendarResponse } from "@/lib/marketCalendarResponse";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return appV2Response(request, () => marketCalendarResponse(request)); }
