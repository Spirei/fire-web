import { securityCapabilities } from "./appSecurityConfig";
import { appIdentity } from "./appAuth";
import { getSessionToken } from "./auth";
import { userTotpEnabled } from "./totpAuth";
import type { User } from "./types";

/** Public identity only; never return grant identifiers, credentials or security stamps. */
export function appProfile(request: Request, user: User) {
  const token = getSessionToken(request) || "";
  const native = token.startsWith("fat_");
  const scope = native ? appIdentity(token, request)?.scope || "" : "";
  const profileWrite = !native || scope.split(" ").includes("profile.write");
  const tradeCapabilities = Object.fromEntries(["assets.read", "positions.read", "cash.read", "orders.read", "orders.write", "orders.cancel"].map(s => [s, native && scope.split(" ").includes(s)]));
  return { ...user, scope, capabilities: { ...securityCapabilities(request, scope, native), ...tradeCapabilities, profileWrite, avatarUpload: profileWrite, emailWrite: true, passwordWrite: true, overviewTotalAssets: true, feedRead: !native || scope.split(" ").includes("feed.read"), feedWrite: !native || scope.split(" ").includes("feed.write") }, security: { twoFactorEnabled: userTotpEnabled(user.id) } };
}
