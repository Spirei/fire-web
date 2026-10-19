import { historicalFeeResponse } from "@/lib/historicalFeeApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return appV2Response(request, () => historicalFeeResponse(request, "submit")); }
