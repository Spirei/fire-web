import * as legacy from "@/app/api/v1/records/operations/[requestId]/route";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: { params: Promise<{ requestId: string }> }) {
  return appV2Response(request, () => legacy.GET(request, context));
}
