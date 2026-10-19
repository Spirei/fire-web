import { historicalFeeResponse } from "@/lib/historicalFeeApi";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return historicalFeeResponse(request, "submit"); }
