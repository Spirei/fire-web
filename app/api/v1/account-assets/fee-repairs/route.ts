import { historicalFeeResponse } from "@/lib/historicalFeeApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return historicalFeeResponse(request, "snapshot"); }
