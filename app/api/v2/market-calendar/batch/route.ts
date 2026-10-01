import { appV2Response } from "@/lib/appApiV2";
import { marketCalendarBatchResponse } from "@/lib/marketCalendarResponse";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return appV2Response(request, () => marketCalendarBatchResponse(request)); }
