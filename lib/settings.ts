import { cache } from "react";
import { headers } from "next/headers";
import { isTransientPlatformError, platformJsonRetry, PlatformError } from "./platformTransport";
import { DEFAULT_SETTINGS } from "./settingsDefaults";
import type { SiteSettings } from "./types";
import { withDataManagementTab } from "./workspaceRouting";
export {
  DEFAULT_HOME_NAV,
  DEFAULT_GROUPS,
  DEFAULT_TICKER,
} from "./settingsDefaults";
export const getSiteSettingsSnapshot = cache(async () => {
  const cookie = (await headers()).get("cookie") || "";
  let result: { settings: Partial<SiteSettings>; revision?: number; privateRevision?: number } = { settings: {} };
  const signedIn = /(?:^|;\s*)(?:fire_session|stocklog_session)=/.test(cookie);
  try {
    result = signedIn
      ? await platformJsonRetry("/api/settings", { cookie })
      : await platformJsonRetry("/api/settings/public");
  } catch (error) {
    if (signedIn && error instanceof PlatformError && error.status === 401) {
      try {
        result = await platformJsonRetry("/api/settings/public");
      } catch (publicError) {
        if (!isTransientPlatformError(publicError)) throw publicError;
        // Keep the shell usable with defaults while the backend recovers.
      }
    } else if (!isTransientPlatformError(error)) throw error;
  }
  const value = { ...DEFAULT_SETTINGS, ...result.settings };
  value.tabs = value.tabs.filter((tab) => tab.key !== "attachments");
  if (!value.tabs.length) value.tabs = DEFAULT_SETTINGS.tabs;
  value.tabs = withDataManagementTab(value.tabs);
  return { settings: value, version: Number.isSafeInteger(result.revision) && Number(result.revision) >= 0 ? { revision: result.revision!, privateRevision: result.privateRevision } : undefined };
});
export const getSiteSettings = cache(async (): Promise<SiteSettings> => (await getSiteSettingsSnapshot()).settings);
