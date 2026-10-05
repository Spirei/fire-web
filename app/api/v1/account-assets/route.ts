import { assetsResponse } from "@/lib/appAssetsApi";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return assetsResponse(request, "snapshot"); }
