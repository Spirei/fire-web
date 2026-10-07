import { assetsResponse } from "@/lib/appAssetsApi";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return assetsResponse(request, "cancel_orders"); }
