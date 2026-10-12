import { tradingResponse } from "@/lib/appTradingApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function PUT(request: Request, { params }: { params: Promise<{ orderId: string }> }) { return appV2Response(request, () => tradingResponse(request, "amend", params)); }
