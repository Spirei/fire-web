import { assetsResponse } from "@/lib/appAssetsApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) { return assetsResponse(request, "operation", context.params); }
