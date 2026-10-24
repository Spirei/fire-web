import { appV2Response } from "@/lib/appApiV2";
import { nativeAccountConsent, nativeLoginResponse } from "@/lib/appNativeLogin";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  const response=await appV2Response(request,()=>nativeLoginResponse(()=>nativeAccountConsent(request)));
  response.headers.set("Cache-Control","private, no-store");
  response.headers.set("Vary","Authorization");
  return response;
}
export const GET=handle;
export const POST=handle;
