import { assetsResponse } from "@/lib/appAssetsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) { return appV2Response(request, () => assetsResponse(request, "operation", context.params)); }
