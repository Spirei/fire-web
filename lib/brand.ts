/** Product presentation only. Never use this name to derive deployed storage or auth identifiers. */
export const PRODUCT_NAME = "Alcor";
export const PRODUCT_SLUG = "alcor";
export const DEFAULT_APP_DEVICE_NAME = `${PRODUCT_NAME} iOS`;

// Protect addresses before replacing names: branding may also contain an email,
// a bare domain, an App callback, or a local/relative image path.
const BRAND_ADDRESS_TOKEN = new RegExp([
  String.raw`(?:[a-z][a-z\d+.-]*:\/{1,2}|www\.)[^\s<>"'，。；！？（）【】]+`,
  String.raw`[a-z\d._%+-]+@[a-z\d.-]+\.[a-z]{2,}\b`,
  String.raw`\b(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'，。；！？（）【】]+)?`,
  String.raw`(?:[a-z]:\\|\.\.?\/|\/|[\w@%+.-]+\/)[^\s<>"'，。；！？（）【】]+`
].join("|"), "gi");
const replaceLegacyProductName = (text: string) => text
  .replace(/\bfire(?:[ \t]+fire)?\b/gi, PRODUCT_NAME)
  .replace(/\balcor[ \t]+web\b/gi, `${PRODUCT_NAME} Api`);

/** Only brand-bearing settings use this adapter; financial FIRE, stock names and URLs do not. */
export function normalizeProductName(value: string): string {
  let cursor = 0;
  let result = "";
  for (const token of value.matchAll(BRAND_ADDRESS_TOKEN)) {
    result += replaceLegacyProductName(value.slice(cursor, token.index)) + token[0];
    cursor = token.index + token[0].length;
  }
  return result + replaceLegacyProductName(value.slice(cursor));
}

/** Adapt only the old shipped default; a user's device nickname is not branding. */
export function normalizeAppDeviceName(value: string): string {
  return /^fire(?:[ \t]+fire)?[ \t]+ios$/i.test(value.trim()) ? DEFAULT_APP_DEVICE_NAME : value;
}

export const BRAND_TEXT_SETTING_KEYS = new Set([
  "title", "logoText", "appDisplayName", "smtpFromName", "heroBadge", "heroTitle",
  "heroSubtitle", "heroCtaPrimary", "heroCtaSecondary", "footerDesc"
]);

export function normalizeBrandSetting(key: string, value: string): string {
  return BRAND_TEXT_SETTING_KEYS.has(key) ? normalizeProductName(value) : value;
}
