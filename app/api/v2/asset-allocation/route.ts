import { assetAllocationResponse } from "@/lib/assetAllocationApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
const response = (request: Request) => appV2Response(request, () => assetAllocationResponse(request, true));
export const GET = response;
export const POST = response;
export const PUT = response;
export const DELETE = response;
