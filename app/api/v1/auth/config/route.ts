import { APP_CLIENT_ID, APP_REDIRECT_URI, APP_SCOPE, APP_SUPPORTED_SCOPES, assertAppOrigin } from "@/lib/appAuth";
import { fail, ok } from "@/lib/api";

/** Same-origin relative endpoints let each installation choose its own domain and port. */
export async function GET(request: Request) {
  try { assertAppOrigin(request); } catch (error) { return fail(40301, (error as Error).message, 403); }
  return ok({ version: 1, client_id: APP_CLIENT_ID, redirect_uri: APP_REDIRECT_URI, scope: APP_SCOPE,
    scopes_supported: APP_SUPPORTED_SCOPES, profile_path: "/api/v1/auth/profile", upload_path: "/api/v1/upload",
    email_path: "/api/v1/auth/email", password_path: "/api/v1/auth/password",
    authorization_path: "/app/authorize", token_path: "/api/v1/auth/token", revoke_path: "/api/v1/auth/revoke", devices_path: "/app/devices", code_challenge_methods_supported: ["S256"] });
}
