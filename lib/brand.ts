/** Product presentation only. Never use this name to derive deployed storage or auth identifiers. */
export const PRODUCT_NAME = "Alcor";
export const PRODUCT_SLUG = "alcor";

/** Only brand-bearing settings use this adapter; financial FIRE, stock names and URLs do not. */
export function normalizeProductName(value: string): string {
  // Branding text can contain links or contact addresses; those are not names.
  return value.replace(
    /(?:https?:\/\/|www\.)[^\s<>"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\bfire(?:\s+fire)?\b/gi,
    token => /^fire(?:\s+fire)?$/i.test(token) ? PRODUCT_NAME : token
  );
}

export const BRAND_TEXT_SETTING_KEYS = new Set([
  "title", "logoText", "appDisplayName", "smtpFromName", "heroBadge", "heroTitle",
  "heroSubtitle", "heroCtaPrimary", "heroCtaSecondary", "footerDesc"
]);

export function normalizeBrandSetting(key: string, value: string): string {
  return BRAND_TEXT_SETTING_KEYS.has(key) ? normalizeProductName(value) : value;
}
