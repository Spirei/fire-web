import { appIdentity } from "./appAuth";
import { getSessionToken } from "./auth";
import type { User } from "./types";

/** Public identity only; never return grant identifiers, credentials or security stamps. */
export function appProfile(request: Request, user: User) {
  const token = getSessionToken(request) || "";
  const native = token.startsWith("fat_");
  const scope = native ? appIdentity(token, request)?.scope || "" : "";
  const profileWrite = !native || scope.split(" ").includes("profile.write");
  return { ...user, scope, capabilities: { profileWrite, avatarUpload: profileWrite, overviewTotalAssets: true } };
}
