import { tradingResponse } from "@/lib/appTradingApi";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) { return tradingResponse(request, "observe", params); }
