import { GET as legacy } from "@/app/api/v1/social-channels/route";
import { appV2Response } from "@/lib/appApiV2";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return appV2Response(request, () => legacy(request));
}
