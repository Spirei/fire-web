import { cache } from "react";
import { headers } from "next/headers";
import { platformJson, PlatformError } from "./platformTransport";
import { DEFAULT_SETTINGS } from "./settingsDefaults";
import type { SiteSettings } from "./types";
export {
  DEFAULT_HOME_NAV,
  DEFAULT_GROUPS,
  DEFAULT_TICKER,
} from "./settingsDefaults";
export const getSiteSettingsSnapshot = cache(async () => {
  const cookie = (await headers()).get("cookie") || "";
  let result: { settings: Partial<SiteSettings>; revision?: number; privateRevision?: number };
  if (/(?:^|;\s*)(?:fire_session|stocklog_session)=/.test(cookie)) {
    try {
      result = await platformJson("/api/settings", { cookie });
    } catch (error) {
      if (!(error instanceof PlatformError) || error.status !== 401)
        throw error;
      result = await platformJson("/api/settings/public");
    }
  } else result = await platformJson("/api/settings/public");
  const value = { ...DEFAULT_SETTINGS, ...result.settings };
  value.tabs = value.tabs.filter((tab) => tab.key !== "attachments");
  if (!value.tabs.length) value.tabs = DEFAULT_SETTINGS.tabs;
  return { settings: value, version: Number.isSafeInteger(result.revision) && Number(result.revision) >= 0 ? { revision: result.revision!, privateRevision: result.privateRevision } : undefined };
});
export const getSiteSettings = cache(async (): Promise<SiteSettings> => (await getSiteSettingsSnapshot()).settings);
