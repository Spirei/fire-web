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
  return { ...user, scope, capabilities: { profileWrite, avatarUpload: profileWrite, emailWrite: true, passwordWrite: true, overviewTotalAssets: true, feedRead: !native || scope.split(" ").includes("feed.read"), feedWrite: !native || scope.split(" ").includes("feed.write") }, security: { twoFactorEnabled: userTotpEnabled(user.id) } };
}
