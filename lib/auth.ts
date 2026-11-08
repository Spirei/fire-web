import { cache } from "react";
import type { WebSession } from "./workspaceInitial";
import { headers } from "next/headers";
import {
  platformJson,
  PlatformError,
  platformConfig,
} from "./platformTransport";
import type { User } from "./types";
export const SESSION_COOKIE = "fire_session";
export const LEGACY_SESSION_COOKIE = "sto" + "cklog_session";
export const getWebSession = cache(async (cookie: string): Promise<WebSession | null> => {
  try {
    return await platformJson<WebSession>("/api/fire/session", { cookie });
  } catch (error) {
    if (error instanceof PlatformError && [401, 403].includes(error.status))
      return null;
    throw error;
  }
});
export async function getAuthUser(request: Request): Promise<User | null> {
  return (await getWebSession(request.headers.get("cookie") || ""))?.user ?? null;
}
export async function getUserByToken(
  token: string | null,
): Promise<User | null> {
  return token
    ? getAuthUser(
        new Request("http://presentation.invalid", {
          headers: {
            cookie:
              (await headers()).get("cookie") ||
              `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
          },
        }),
      )
    : null;
}
export const isAdmin = (user: User | null | undefined) =>
  user?.role === "admin";
export async function needsSetup() {
  return (await platformJson<{ first_user: boolean }>("/api/auth/registration"))
    .first_user;
}
export function isTrustedMutationRequest(request: Request) {
  return request.headers.get("origin") === platformConfig().publicOrigin.origin;
}
