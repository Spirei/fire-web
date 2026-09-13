import type { SiteSettings } from "./types";

// Explicit allowlist: new server settings must be reviewed before reaching a browser.
const CLIENT_KEYS = [
  "domain", "title", "ico", "homepageBg", "loginSideImage", "tabs", "groups", "homeNav",
  "markets", "marketLabels", "marketBadges", "marketBadgesVisible", "assetMarketOrder",
  "assetAnalysisOrder", "indicesOrder", "holdingColumns", "allowRegister", "stockIconCdn",
  "siteLogo", "logoText", "logoFont", "quoteSource", "footerDesc", "quoteApiUrl", "searchApiUrl",
  "chartApiUrl", "currencyApiUrl", "earningsApiUrl", "cnEarningsApiUrl", "hkEarningsApiUrl",
  "usLogoApiUrl", "cnLogoApiUrl", "trumpArchiveApiUrl", "translationApiUrl", "translationEnabled",
  "translationProvider", "deepseekApiUrl", "deepseekModel", "llmProvider", "llmApiUrl", "llmModel",
  "tradingSquareTrumpRefreshMinutes", "tradingSquareDuanRefreshMinutes", "dbType", "ticker"
] as const satisfies readonly (keyof SiteSettings)[];

export function clientSettings(settings: SiteSettings, admin: boolean) {
  return {
    ...Object.fromEntries(CLIENT_KEYS.map(key => [key, settings[key]])),
    futuHost: admin ? settings.futuHost : "", futuPort: admin ? settings.futuPort : "",
    pgHost: admin ? settings.pgHost : "", pgPort: admin ? settings.pgPort : "",
    pgDatabase: admin ? settings.pgDatabase : "", pgUser: admin ? settings.pgUser : "",
    pgPassword: "", llmApiKey: "", deepseekApiKey: "", xueqiuCookie: "",
    pgPasswordConfigured: admin && Boolean(settings.pgPassword),
    llmApiKeyConfigured: admin && Boolean(settings.llmApiKey || settings.deepseekApiKey),
    xueqiuCookieConfigured: admin && Boolean(settings.xueqiuCookie)
  };
}
