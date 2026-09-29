import { APP_CLIENT_ID, APP_REDIRECT_URI, APP_SCOPE, assertAppOrigin } from "@/lib/appAuth";
import { fail, ok } from "@/lib/api";

/** Same-origin relative endpoints let each installation choose its own domain and port. */
export async function GET(request: Request) {
  try { assertAppOrigin(request); } catch (error) { return fail(40301, (error as Error).message, 403); }
  return ok({ version: 1, client_id: APP_CLIENT_ID, redirect_uri: APP_REDIRECT_URI, scope: APP_SCOPE,
    authorization_path: "/app/authorize", token_path: "/api/v1/auth/token", revoke_path: "/api/v1/auth/revoke", devices_path: "/app/devices", code_challenge_methods_supported: ["S256"] });
}
