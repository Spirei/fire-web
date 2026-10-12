import { assetsResponse } from "@/lib/appAssetsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return appV2Response(request, () => assetsResponse(request, "orders")); }
