import { passkeyConfig } from "./passkeys";
import { mailConfigured } from "./mail";
import { verificationOrigin } from "./emailVerification";

export function nativePasskeyRegistration() {
  const config = passkeyConfig();
  // No verified signing entitlement/AASA relationship exists in this deployment contract.
  return { supported: false, rpID: config.rpID, origin: config.origin, reason: "associated_domain_unverified" };
}
export function securityDiscovery(version: 1 | 2 = 1) {
  const base=`/api/v${version}/auth`;
  return { version, read_scope: "security.read", write_scope: "security.write",
    email_verification_path: `${base}/email-verification`, totp_path: `${base}/totp`,
    passkeys_path: `${base}/passkeys`, devices_path: `${base}/security-devices`,
    password_reset_path: `${base}/password-reset`, passkey_registration: nativePasskeyRegistration() };
}
export function securityCapabilities(request: Request, scope: string, native: boolean) {
  const read = native && scope.split(" ").includes("security.read");
  const write = native && scope.split(" ").includes("security.write");
  return { emailVerification: write && mailConfigured() && !!verificationOrigin(request),
    twoFactorRead: read, twoFactorWrite: write, passkeysRead: read, passkeysWrite: write,
    passkeyRegistration: false, devicesRead: read, devicesWrite: write, passwordRecovery: true };
}
