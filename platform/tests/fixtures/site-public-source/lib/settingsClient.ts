import type { SiteSettings } from "./types";
import { publicSiteDomain } from "./publicSiteUrl";

// Explicit allowlist: new server settings must be reviewed before reaching a browser.
const CLIENT_KEYS = [
  "domain", "title", "ico", "pwaIcon", "homepageBg", "loginSideImage", "tabs", "mobileNavigationOrder", "groups", "homeNav",
  "markets", "marketLabels", "marketBadges", "marketBadgesVisible", "assetMarketOrder",
  "assetAnalysisOrder", "indicesOrder", "holdingColumns", "allowRegister", "stockIconCdn",
  "siteLogo", "appDisplayName", "appDisplayIcon", "logoText", "logoFont", "quoteSource", "footerDesc", "quoteApiUrl", "searchApiUrl",
  "chartApiUrl", "currencyApiUrl", "currencyRefreshPattern", "earningsApiUrl", "cnEarningsApiUrl", "hkEarningsApiUrl",
  "usLogoApiUrl", "cnLogoApiUrl", "trumpArchiveApiUrl", "translationApiUrl", "translationEnabled",
  "translationProvider", "deepseekApiUrl", "deepseekModel", "llmProvider", "llmApiUrl", "llmModel",
  "tradingSquareTrumpRefreshMinutes", "tradingSquareDuanRefreshMinutes", "dbType", "ticker"
] as const satisfies readonly (keyof SiteSettings)[];

/** Legacy URLs may contain credentials; redact the copy without mutating the saved source. */
function clientSettingValue(key: typeof CLIENT_KEYS[number], value: SiteSettings[typeof CLIENT_KEYS[number]], admin: boolean) {
  if (!key.endsWith("ApiUrl") || typeof value !== "string") return value;
  // Data and model APIs are consumed by server routes. Only these public image bases
  // are used directly by the earnings calendar; keep their non-secret parameters.
  if (!admin && key !== "usLogoApiUrl" && key !== "cnLogoApiUrl") return "";
  try {
    const url = new URL(value);
    let changed = Boolean(url.username || url.password);
    url.username = ""; url.password = "";
    if (!admin) {
      for (const name of [...url.searchParams.keys()]) {
        if (/^(?:api[_-]?key|key|token|access[_-]?token|secret|password|signature|auth|authorization)$/i.test(name)) {
          url.searchParams.delete(name); changed = true;
        }
      }
    }
    if (!changed) return value;
    return url.href;
  } catch { return ""; }
}

export function clientSettings(settings: SiteSettings, admin: boolean) {
  return {
    ...Object.fromEntries(CLIENT_KEYS.map(key => [key, clientSettingValue(key, settings[key], admin)])),
    domain: admin ? settings.domain : publicSiteDomain(settings.domain),
    futuHost: admin ? settings.futuHost : "", futuPort: admin ? settings.futuPort : "",
    pgHost: admin ? settings.pgHost : "", pgPort: admin ? settings.pgPort : "",
    pgDatabase: admin ? settings.pgDatabase : "", pgUser: admin ? settings.pgUser : "",
    pgPassword: "", llmApiKey: "", deepseekApiKey: "", xueqiuCookie: "",
    smtpHost: admin ? settings.smtpHost : "", smtpPort: admin ? settings.smtpPort : "",
    smtpSecure: admin && settings.smtpSecure, smtpUser: admin ? settings.smtpUser : "",
    smtpPassword: "", smtpFromName: admin ? settings.smtpFromName : "", smtpFromEmail: admin ? settings.smtpFromEmail : "",
    emailLinkOrigin: admin ? settings.emailLinkOrigin : "",
    smtpPasswordConfigured: admin && Boolean(settings.smtpPassword),
    wechatEnabled: admin && settings.wechatEnabled, wechatName: admin ? settings.wechatName : "", wechatSmartRobot: admin && settings.wechatSmartRobot,
    wechatCorpId: admin ? settings.wechatCorpId : "", wechatAgentId: admin ? settings.wechatAgentId : "",
    wechatSecret: "", wechatSecretConfigured: admin && Boolean(settings.wechatSecret),
    wechatProxyUrl: admin ? settings.wechatProxyUrl : "", wechatToken: "", wechatTokenConfigured: admin && Boolean(settings.wechatToken),
    wechatAesKey: "", wechatAesKeyConfigured: admin && Boolean(settings.wechatAesKey), wechatAdminIds: admin ? settings.wechatAdminIds : "",
    wechatWebhook: "", wechatWebhookConfigured: admin && Boolean(settings.wechatWebhook),
    telegramEnabled: admin && settings.telegramEnabled, telegramName: admin ? settings.telegramName : "", telegramTypes: admin ? settings.telegramTypes : "",
    telegramBotUsername: admin ? settings.telegramBotUsername : "", telegramBotToken: "", telegramBotTokenConfigured: admin && Boolean(settings.telegramBotToken),
    telegramChatId: admin ? settings.telegramChatId : "", telegramUserIds: admin ? settings.telegramUserIds : "", telegramAdminIds: admin ? settings.telegramAdminIds : "",
    telegramApiBase: admin ? settings.telegramApiBase : "",
    feishuEnabled: admin && settings.feishuEnabled, feishuName: admin ? settings.feishuName : "", feishuTypes: admin ? settings.feishuTypes : "",
    feishuAppId: admin ? settings.feishuAppId : "", feishuAppSecret: "", feishuAppSecretConfigured: admin && Boolean(settings.feishuAppSecret),
    feishuOpenId: admin ? settings.feishuOpenId : "", feishuChatId: admin ? settings.feishuChatId : "", feishuAdminIds: admin ? settings.feishuAdminIds : "",
    feishuVerificationToken: "", feishuVerificationTokenConfigured: admin && Boolean(settings.feishuVerificationToken),
    feishuEncryptKey: "", feishuEncryptKeyConfigured: admin && Boolean(settings.feishuEncryptKey),
    feishuWebhook: "", feishuWebhookConfigured: admin && Boolean(settings.feishuWebhook),
    qqEnabled: admin && settings.qqEnabled, qqName: admin ? settings.qqName : "", qqTypes: admin ? settings.qqTypes : "",
    qqAppId: admin ? settings.qqAppId : "", qqAppSecret: "", qqAppSecretConfigured: admin && Boolean(settings.qqAppSecret),
    qqUserOpenId: admin ? settings.qqUserOpenId : "", qqGroupOpenId: admin ? settings.qqGroupOpenId : "", qqAdminIds: admin ? settings.qqAdminIds : "",
    discordEnabled: admin && settings.discordEnabled, discordName: admin ? settings.discordName : "", discordTypes: admin ? settings.discordTypes : "",
    discordBotToken: "", discordBotTokenConfigured: admin && Boolean(settings.discordBotToken),
    discordGuildId: admin ? settings.discordGuildId : "", discordChannelId: admin ? settings.discordChannelId : "", discordAdminIds: admin ? settings.discordAdminIds : "",
    webPushEnabled: admin && settings.webPushEnabled, webPushName: admin ? settings.webPushName : "", webPushTypes: admin ? settings.webPushTypes : "", webPushUsername: admin ? settings.webPushUsername : "",
    pgPasswordConfigured: admin && Boolean(settings.pgPassword),
    llmApiKeyConfigured: admin && Boolean(settings.llmApiKey || settings.deepseekApiKey),
    modelServicesError: admin ? settings.modelServicesError : undefined,
    modelServicesInitialized: admin && settings.modelServicesInitialized,
    modelServicesRevision: admin ? settings.modelServicesRevision : undefined,
    modelServices: admin ? settings.modelServices.map(service => ({
      id: service.id, name: service.name, provider: service.provider, icon: service.icon, icons: service.icons,
      apiUrl: service.apiUrl, models: service.models,
      apiKey: "",
      apiKeyConfigured: Boolean(service.apiKey),
      providerConfigs: Object.fromEntries(Object.entries(service.providerConfigs || {}).map(([provider, config]) => [provider, {
        apiUrl: config!.apiUrl, models: config!.models, apiKey: "", apiKeyConfigured: Boolean(config!.apiKey)
      }]))
    })) : [],
    xueqiuCookieConfigured: admin && Boolean(settings.xueqiuCookie)
  };
}
