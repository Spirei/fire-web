import { assetsResponse } from "@/lib/appAssetsApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ recordId: string }> }) { return assetsResponse(request, "instrument", context.params); }
export async function PUT(request: Request, context: { params: Promise<{ recordId: string }> }) { return assetsResponse(request, "instrument", context.params); }
