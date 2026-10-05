import { accountChange } from "@/lib/appAccountChange";
import { securityResponse } from "@/lib/appSecurity";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const response = await securityResponse(() => accountChange(request,"password","verify"),request);
  response.headers.set("Cache-Control","private, no-store");
  return response;
}
