import { assetsResponse } from "@/lib/appAssetsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return appV2Response(request, () => assetsResponse(request, "cancel_orders")); }
