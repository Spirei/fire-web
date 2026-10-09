import { assetAllocationResponse } from "@/lib/assetAllocationApi";
import { appV2Response } from "@/lib/appApiV2";
export const POST = (request: Request) => appV2Response(request, () => assetAllocationResponse(request, true));
