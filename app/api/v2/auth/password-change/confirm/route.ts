import { accountChange } from "@/lib/appAccountChange";
import { securityResponse } from "@/lib/appSecurity";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const response = await appV2Response(request, () => securityResponse(() => accountChange(request,"password","confirm"),request));
  response.headers.set("Cache-Control","private, no-store");
  return response;
}
