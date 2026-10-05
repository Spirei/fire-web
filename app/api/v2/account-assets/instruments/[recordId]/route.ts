import { assetsResponse } from "@/lib/appAssetsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ recordId: string }> }) { return appV2Response(request, () => assetsResponse(request, "instrument", context.params)); }
export async function PUT(request: Request, context: { params: Promise<{ recordId: string }> }) { return appV2Response(request, () => assetsResponse(request, "instrument", context.params)); }
