import { APP_CLIENT_ID, APP_SCOPE, APP_SUPPORTED_SCOPES } from "./appAuth";
import { emailRegistrationDiscovery } from "./emailRegistration";

/** Discovery stays independent of credential verification and factor consumption. */
export function nativeLoginDiscovery() {
  return { supported: true, version: 2, api_version: 2, client_id: APP_CLIENT_ID, email_registration: emailRegistrationDiscovery(),
    login_path: "/api/v2/auth/login", two_factor_path: "/api/v2/auth/login/totp",
    permissions_path: "/api/v2/auth/permissions", permissions_authentication: "current_grant", permissions_requires_password: false, permissions_requires_2fa: false, scope: APP_SCOPE,
    account_consent: { version: 1, path: "/api/v2/auth/consent", authentication: "current_grant", scope_source: "account_client" },
    scopes_supported: APP_SUPPORTED_SCOPES, factors: ["totp", "backup_code"], challenge_expires_in: 300 };
}
