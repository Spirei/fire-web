import type { SiteSettings } from "./types";

export type AppConnectionBrand = { siteName: string; siteLogo: string; appName: string; appIcon: string };
export const DEFAULT_APP_ICON = "/fire-app-icon.svg";

export function isConnectionIconUrl(value: string) {
  if (!value) return true;
  if (value.length > 2048 || /[\\\s\x00-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

/** Presentation follows site settings; OAuth client and callback validation stay independent. */
export function appConnectionBrand(settings: Pick<SiteSettings, "logoText" | "title" | "siteLogo" | "ico" | "pwaIcon" | "appDisplayName" | "appDisplayIcon">): AppConnectionBrand {
  const siteName = settings.logoText.trim() || settings.title.trim() || "Fire";
  const image = (...values: string[]) => values.find(value => value && isConnectionIconUrl(value)) || "";
  return { siteName, siteLogo: image(settings.siteLogo, settings.ico, "/site-icon.svg"), appName: settings.appDisplayName.trim() || `${siteName} App`, appIcon: image(settings.appDisplayIcon, settings.pwaIcon, DEFAULT_APP_ICON) };
}
