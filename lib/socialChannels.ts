import { getSiteSettings } from "./settings";
import type { SiteSettings } from "./types";
import { mailConfigured } from "./mail";

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

/** Reject bad channel credentials before they are stored. Empty secrets keep the saved value. */
export function assertSocialPatch(current: SiteSettings, patch: Partial<SiteSettings>) {
  for (const [key, label] of [["wechatWebhook", "微信 Webhook"], ["feishuWebhook", "飞书 Webhook"]] as const) {
    const incoming = patch[key];
    if (typeof incoming !== "string") continue;
    const trimmed = incoming.trim();
    if (trimmed && trimmed !== "********" && !httpsWebhook(trimmed)) throw new SocialConfigError(`${label}必须是 https 地址`);
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
  const wechatOn = typeof patch.wechatEnabled === "boolean" ? patch.wechatEnabled : current.wechatEnabled;
  if (wechatOn && !httpsWebhook(keptSecret(current.wechatWebhook, patch.wechatWebhook))) throw new SocialConfigError("开启微信前请填写 Webhook");
  const feishuOn = typeof patch.feishuEnabled === "boolean" ? patch.feishuEnabled : current.feishuEnabled;
  if (feishuOn && !httpsWebhook(keptSecret(current.feishuWebhook, patch.feishuWebhook))) throw new SocialConfigError("开启飞书前请填写 Webhook");
  const telegramOn = typeof patch.telegramEnabled === "boolean" ? patch.telegramEnabled : current.telegramEnabled;
  if (telegramOn) {
    const token = keptSecret(current.telegramBotToken, patch.telegramBotToken) || process.env.ALCOR_TELEGRAM_BOT_TOKEN || "";
    const username = (typeof patch.telegramBotUsername === "string" ? patch.telegramBotUsername : current.telegramBotUsername) || process.env.ALCOR_TELEGRAM_BOT_USERNAME || "";
    if (!TOKEN.test(token) || !USERNAME.test(username.replace(/^@/, ""))) throw new SocialConfigError("开启 Telegram 前请填写机器人用户名和令牌");
  }
}

export function telegramBotToken() {
  return getSiteSettings().telegramBotToken || process.env.ALCOR_TELEGRAM_BOT_TOKEN || "";
}
export function telegramBotUsername() {
  return (getSiteSettings().telegramBotUsername || process.env.ALCOR_TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
}
export function telegramReady() {
  const settings = getSiteSettings();
  return settings.telegramEnabled && TOKEN.test(telegramBotToken()) && USERNAME.test(telegramBotUsername());
}

/** App-visible channel status. Secrets stay on the server. */
export function socialChannelsSnapshot() {
  const settings = getSiteSettings();
  const username = telegramBotUsername();
  return {
    version: 1,
    channels: [
      { id: "wechat", name: "微信", enabled: settings.wechatEnabled, configured: httpsWebhook(settings.wechatWebhook), bindable: false },
      { id: "telegram", name: "Telegram", enabled: settings.telegramEnabled, configured: telegramReady(), bindable: true, bot_username: username },
      { id: "feishu", name: "飞书", enabled: settings.feishuEnabled, configured: httpsWebhook(settings.feishuWebhook), bindable: false },
      { id: "email", name: "邮件", enabled: mailConfigured(), configured: mailConfigured(), bindable: false }
    ]
  };
}

export function socialChannelsDiscovery(version: 1 | 2) {
  return { version: 1, path: `/api/v${version}/social-channels`, read_scope: "portfolio.read", channels: ["wechat", "telegram", "feishu", "email"] };
}
