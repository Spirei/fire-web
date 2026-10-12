import { tradingResponse } from "@/lib/appTradingApi";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return tradingResponse(request, "submit"); }
