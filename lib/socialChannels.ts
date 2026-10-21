import { getDb } from "./db";
import { getSiteSettings } from "./settings";
import type { SiteSettings } from "./types";
import { mailConfigured } from "./mail";
import { TELEGRAM_CHANNEL_TYPES } from "./notifyChannelTypes";

export { TELEGRAM_CHANNEL_TYPES };
export class SocialConfigError extends Error {}

const TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const USERNAME = /^[A-Za-z0-9_]{5,32}$/;

export function httpsWebhook(value: string) {
  if (!value || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function keptSecret(current: string, incoming: unknown) {
  if (typeof incoming !== "string") return current;
  const trimmed = incoming.trim();
  if (!trimmed || trimmed === "********") return current;
  return trimmed;
}

function idList(value: string) {
  return value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean);
}

function touches(patch: Partial<SiteSettings>, keys: (keyof SiteSettings)[]) {
  return keys.some(key => patch[key] !== undefined);
}

/** Reject bad channel credentials before they are stored. Empty secrets keep the saved value. */
export function assertSocialPatch(current: SiteSettings, patch: Partial<SiteSettings>) {
  if (typeof patch.wechatProxyUrl === "string" && patch.wechatProxyUrl.trim() && !httpsWebhook(patch.wechatProxyUrl.trim())) throw new SocialConfigError("企业微信代理地址必须是 https 地址");
  if (typeof patch.wechatWebhook === "string" && patch.wechatWebhook.trim() && patch.wechatWebhook.trim() !== "********" && !httpsWebhook(patch.wechatWebhook.trim())) throw new SocialConfigError("微信 Webhook 必须是 https 地址");
  if (typeof patch.feishuWebhook === "string" && patch.feishuWebhook.trim() && patch.feishuWebhook.trim() !== "********" && !httpsWebhook(patch.feishuWebhook.trim())) throw new SocialConfigError("飞书 Webhook 必须是 https 地址");
  if (typeof patch.wechatAgentId === "string" && patch.wechatAgentId.trim() && !/^\d{1,12}$/.test(patch.wechatAgentId.trim())) throw new SocialConfigError("应用 AgentId 须为数字");
  if (typeof patch.wechatCorpId === "string" && patch.wechatCorpId.trim() && !/^[A-Za-z0-9_-]{1,64}$/.test(patch.wechatCorpId.trim())) throw new SocialConfigError("企业 ID 格式无效");
  for (const key of ["wechatAdminIds", "telegramUserIds", "telegramAdminIds"] as const) {
    const value = patch[key];
    if (typeof value !== "string") continue;
    const ids = idList(value);
    if (ids.length > 50 || ids.some(id => !/^[A-Za-z0-9_@.:-]{1,64}$/.test(id))) throw new SocialConfigError("白名单请用逗号分隔，每项最多 64 个字符");
    patch[key] = ids.join(",");
  }
  if (typeof patch.telegramChatId === "string" && patch.telegramChatId.trim()) {
    const ids = idList(patch.telegramChatId);
    if (ids.some(id => !/^-?\d{1,20}$/.test(id))) throw new SocialConfigError("Chat ID 须为数字，多个用逗号分隔");
    patch.telegramChatId = ids.join(",");
  }
  if (typeof patch.telegramTypes === "string") {
    const types = patch.telegramTypes.split(",").map(item => item.trim()).filter(Boolean);
    if (types.some(type => !(TELEGRAM_CHANNEL_TYPES as readonly string[]).includes(type))) throw new SocialConfigError("通知渠道类型无效");
    patch.telegramTypes = types.join(",");
  }
  if (typeof patch.telegramApiBase === "string") {
    const base = patch.telegramApiBase.trim().replace(/\/$/, "");
    patch.telegramApiBase = base;
    if (base && !httpsWebhook(base)) throw new SocialConfigError("代理 API 地址必须是 https 地址");
  }
  if (typeof patch.telegramBotUsername === "string") {
    const name = patch.telegramBotUsername.trim().replace(/^@/, "");
    patch.telegramBotUsername = name;
    if (name && !USERNAME.test(name)) throw new SocialConfigError("Telegram 机器人用户名无效");
  }
  if (typeof patch.telegramBotToken === "string") {
    const token = patch.telegramBotToken.trim();
    if (token && token !== "********" && !TOKEN.test(token)) throw new SocialConfigError("Telegram 机器人令牌无效");
  }
  if (typeof patch.wechatAesKey === "string") {
    const key = patch.wechatAesKey.trim();
    if (key && key !== "********" && !/^[A-Za-z0-9]{43}$/.test(key)) throw new SocialConfigError("EncodingAESKey 须为 43 位");
  }
  if (touches(patch, ["wechatEnabled", "wechatCorpId", "wechatAgentId", "wechatSecret", "wechatSmartRobot"])) {
    const enabled = typeof patch.wechatEnabled === "boolean" ? patch.wechatEnabled : current.wechatEnabled;
    const corp = (typeof patch.wechatCorpId === "string" ? patch.wechatCorpId : current.wechatCorpId).trim();
    const agent = (typeof patch.wechatAgentId === "string" ? patch.wechatAgentId : current.wechatAgentId).trim();
    const secret = keptSecret(current.wechatSecret, patch.wechatSecret);
    if (enabled && (!corp || !agent || !secret)) throw new SocialConfigError("启用企业微信前请填写企业 ID、AgentId 和应用 Secret");
  }
  if (touches(patch, ["telegramEnabled", "telegramBotToken"])) {
    const enabled = typeof patch.telegramEnabled === "boolean" ? patch.telegramEnabled : current.telegramEnabled;
    const token = keptSecret(current.telegramBotToken, patch.telegramBotToken) || process.env.ALCOR_TELEGRAM_BOT_TOKEN || "";
    if (enabled && !TOKEN.test(token)) throw new SocialConfigError("启用 Telegram 前请填写 Bot Token");
  }
  if (typeof patch.feishuTypes === "string" || typeof patch.qqTypes === "string" || typeof patch.discordTypes === "string" || typeof patch.webPushTypes === "string") {
    for (const key of ["feishuTypes", "qqTypes", "discordTypes", "webPushTypes"] as const) {
      if (typeof patch[key] !== "string") continue;
      const types = patch[key].split(",").map(item => item.trim()).filter(Boolean);
      if (types.some(type => !(TELEGRAM_CHANNEL_TYPES as readonly string[]).includes(type))) throw new SocialConfigError("通知渠道类型无效");
      patch[key] = types.join(",");
    }
  }
  for (const key of ["feishuAdminIds", "qqAdminIds", "discordAdminIds"] as const) {
    const value = patch[key];
    if (typeof value !== "string") continue;
    const ids = idList(value);
    if (ids.length > 50 || ids.some(id => !/^[A-Za-z0-9_@.:-]{1,64}$/.test(id))) throw new SocialConfigError("白名单请用逗号分隔，每项最多 64 个字符");
    patch[key] = ids.join(",");
  }
  if (touches(patch, ["feishuEnabled", "feishuAppId", "feishuAppSecret"])) {
    const enabled = typeof patch.feishuEnabled === "boolean" ? patch.feishuEnabled : current.feishuEnabled;
    const appId = (typeof patch.feishuAppId === "string" ? patch.feishuAppId : current.feishuAppId).trim();
    const secret = keptSecret(current.feishuAppSecret, patch.feishuAppSecret);
    if (enabled && (!appId || !secret)) throw new SocialConfigError("启用飞书前请填写 App ID 和 App Secret");
  }
  if (touches(patch, ["qqEnabled", "qqAppId", "qqAppSecret"])) {
    const enabled = typeof patch.qqEnabled === "boolean" ? patch.qqEnabled : current.qqEnabled;
    const appId = (typeof patch.qqAppId === "string" ? patch.qqAppId : current.qqAppId).trim();
    const secret = keptSecret(current.qqAppSecret, patch.qqAppSecret);
    if (enabled && (!/^\d{4,20}$/.test(appId) || !secret)) throw new SocialConfigError("启用 QQ 前请填写 AppID 和 AppSecret");
  }
  if (touches(patch, ["discordEnabled", "discordBotToken", "discordGuildId", "discordChannelId"])) {
    const enabled = typeof patch.discordEnabled === "boolean" ? patch.discordEnabled : current.discordEnabled;
    const token = keptSecret(current.discordBotToken, patch.discordBotToken);
    const guild = (typeof patch.discordGuildId === "string" ? patch.discordGuildId : current.discordGuildId).trim();
    const channel = (typeof patch.discordChannelId === "string" ? patch.discordChannelId : current.discordChannelId).trim();
    if (guild && !/^\d{1,22}$/.test(guild)) throw new SocialConfigError("Discord 服务器 ID 须为数字");
    if (channel && !/^\d{1,22}$/.test(channel)) throw new SocialConfigError("Discord 频道 ID 须为数字");
    if (enabled && token.length < 20) throw new SocialConfigError("启用 Discord 前请填写 Bot Token");
  }
  if (touches(patch, ["webPushEnabled", "webPushUsername"])) {
    const enabled = typeof patch.webPushEnabled === "boolean" ? patch.webPushEnabled : current.webPushEnabled;
    const username = (typeof patch.webPushUsername === "string" ? patch.webPushUsername : current.webPushUsername).trim();
    if (typeof patch.webPushUsername === "string") patch.webPushUsername = username;
    if (enabled && !/^[\w\u4e00-\u9fff.@-]{1,64}$/.test(username)) throw new SocialConfigError("启用 WebPush 前请填写登录用户名");
  }
}

export function telegramBotToken() {
  return getSiteSettings().telegramBotToken || process.env.ALCOR_TELEGRAM_BOT_TOKEN || "";
}
export function telegramBotUsername() {
  return (getSiteSettings().telegramBotUsername || process.env.ALCOR_TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
}
export function telegramApiBase() {
  return (getSiteSettings().telegramApiBase || "https://api.telegram.org").replace(/\/$/, "");
}
export function telegramReady() {
  if (!TOKEN.test(telegramBotToken())) return false;
  const row = getDb().prepare("SELECT value FROM site_settings WHERE key='telegramEnabled'").get() as { value: string } | undefined;
  if (row && row.value !== "") return row.value === "1";
  return USERNAME.test(telegramBotUsername());
}
export function wechatReady() {
  const settings = getSiteSettings();
  return settings.wechatEnabled && Boolean(settings.wechatCorpId && settings.wechatAgentId && settings.wechatSecret);
}

/** App-visible channel status. Secrets stay on the server. */
export function socialChannelsSnapshot() {
  const settings = getSiteSettings();
  return {
    version: 2,
    channels: [
      { id: "wechat", name: settings.wechatName || "企业微信", kind: "wecom", enabled: settings.wechatEnabled, configured: wechatReady(), smart_robot: settings.wechatSmartRobot, bindable: false },
      { id: "telegram", name: settings.telegramName || "电报", enabled: settings.telegramEnabled, configured: telegramReady(), bindable: true, bot_username: telegramBotUsername(), types: settings.telegramTypes.split(",").filter(Boolean), api_base: telegramApiBase() },
      { id: "feishu", name: settings.feishuName || "飞书", enabled: settings.feishuEnabled, configured: settings.feishuEnabled && Boolean(settings.feishuAppId && settings.feishuAppSecret), types: settings.feishuTypes.split(",").filter(Boolean), bindable: false },
      { id: "qq", name: settings.qqName || "QQ", enabled: settings.qqEnabled, configured: settings.qqEnabled && Boolean(settings.qqAppId && settings.qqAppSecret), types: settings.qqTypes.split(",").filter(Boolean), bindable: false },
      { id: "discord", name: settings.discordName || "Discord", enabled: settings.discordEnabled, configured: settings.discordEnabled && settings.discordBotToken.length >= 20, types: settings.discordTypes.split(",").filter(Boolean), bindable: false },
      { id: "webpush", name: settings.webPushName || "WebPush", enabled: settings.webPushEnabled, configured: settings.webPushEnabled && Boolean(settings.webPushUsername), types: settings.webPushTypes.split(",").filter(Boolean), bindable: false },
      { id: "email", name: "邮件", enabled: mailConfigured(), configured: mailConfigured(), bindable: false }
    ]
  };
}

export function socialChannelsDiscovery(version: 1 | 2) {
  return { version: 2, path: `/api/v${version}/social-channels`, read_scope: "portfolio.read", channels: ["wechat", "telegram", "feishu", "qq", "discord", "webpush", "email"] };
}
