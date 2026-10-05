import nodemailer from "nodemailer";
import { getSiteSettings } from "./settings";
import { consumeMailPermit, type MailPermit } from "./mailBudget";
import { normalizeProductName } from "./brand";
import { sameSmtpDestination, SmtpDestinationError } from "./smtpConfig";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

export function getMailConfig() {
  const settings = getSiteSettings();
  const port = Number(settings.smtpPort || process.env.SMTP_PORT || 587);
  return {
    host: settings.smtpHost || process.env.SMTP_HOST || "",
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 587,
    secure: settings.smtpHost ? settings.smtpSecure : process.env.SMTP_SECURE === "true",
    user: settings.smtpUser || process.env.SMTP_USER || "",
    password: settings.smtpPassword || process.env.SMTP_PASSWORD || "",
    fromName: normalizeProductName(settings.smtpFromName || process.env.SMTP_FROM_NAME || "Alcor"),
    fromEmail: settings.smtpFromEmail || process.env.SMTP_FROM_EMAIL || ""
  };
}

export type MailConfigInput = Partial<ReturnType<typeof getMailConfig>>;

function resolveMailConfig(input?: MailConfigInput) {
  const saved = getMailConfig();
  if (!input) return saved;
  const port = Number(input.port ?? saved.port);
  const config = {
    host: String(input.host ?? saved.host).trim(),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : saved.port,
    secure: typeof input.secure === "boolean" ? input.secure : saved.secure,
    user: String(input.user ?? saved.user).trim(),
    password: input.password ? String(input.password) : "",
    fromName: normalizeProductName(String(input.fromName ?? saved.fromName).trim()),
    fromEmail: String(input.fromEmail ?? saved.fromEmail).trim()
  };
  if (!config.password && saved.password) {
    if (!sameSmtpDestination(config, saved)) throw new SmtpDestinationError();
    config.password = saved.password;
  }
  return config;
}

export function mailConfigured() {
  const config = getMailConfig();
  return Boolean(config.host && config.fromEmail);
}

function createMailTransport(config: ReturnType<typeof getMailConfig>) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
}

export async function sendPasswordResetEmail(input: { to: string; name: string; code: string; minutes: number; native?: boolean }, permit?: MailPermit) {
  const config = getMailConfig();
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  consumeMailPermit(input.to, "reset", permit);
  const transport = createMailTransport(config);
  const siteName = config.fromName || "Alcor";
  const safeName = escapeHtml(input.name || "你好");
  const safeCode = escapeHtml(input.code);
  await transport.sendMail({
    from: { name: siteName, address: config.fromEmail },
    to: input.to,
    subject: `${siteName} 密码重置验证码`,
    text: `${input.name || "你好"}，你的密码重置验证码是：\n\n${input.code}\n\n${input.minutes} 分钟内有效，只能使用一次。请勿向任何人提供验证码。如果不是你发起的，请忽略此邮件。`,
    html: `<div style="max-width:480px;margin:24px auto;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21;border:1px solid #dedfe3;border-radius:16px"><h2 style="margin:0 0 16px;font-size:22px">重置密码</h2><p>${safeName}，请在${input.native ? "Alcor App" : "网页"}中输入以下验证码：</p><div style="margin:24px 0;padding:20px 8px;border-radius:12px;background:#f2f4f7;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace">${safeCode}</div><p style="color:#65676b;font-size:13px;line-height:1.7">${input.minutes} 分钟内有效，只能使用一次。请勿向任何人提供验证码。<br>如果不是你发起的，请忽略此邮件。</p></div>`
  });
}

export async function sendTestEmail(to: string, input?: MailConfigInput) {
  const config = resolveMailConfig(input);
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置完整");
  consumeMailPermit(to, "test");
  const transport = createMailTransport(config);
  await transport.sendMail({
    from: { name: config.fromName || "Alcor", address: config.fromEmail },
    to,
    subject: "Alcor 邮件服务测试",
    text: "邮件服务配置成功。你现在可以使用邮箱自助找回密码。",
    html: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif"><h2>配置成功</h2><p>你现在可以使用邮箱自助找回密码。</p></div>'
  });
}

export async function sendEmailVerification(to: string, url: string, permit?: MailPermit, nativeToken?: string) {
  const config=getMailConfig();
  if(!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  consumeMailPermit(to, "verification", permit);
  const transport=createMailTransport(config);
  const nativeText = nativeToken ? `\n\n也可在 Alcor App 的邮箱验证页粘贴以下一次性凭证：\n${nativeToken}` : "";
  const nativeHtml = nativeToken ? `<p>也可在 Alcor App 的邮箱验证页粘贴以下一次性凭证：</p><p style="word-break:break-all;font-family:monospace">${escapeHtml(nativeToken)}</p>` : "";
  await transport.sendMail({from:{name:config.fromName||"Alcor",address:config.fromEmail},to,subject:`确认你的 ${config.fromName||"Alcor"} 邮箱`,text:`请打开以下链接确认邮箱：\n\n${url}${nativeText}\n\n30 分钟内有效。如果不是你发起的，请忽略此邮件。`,html:`<div style="max-width:480px;margin:24px auto;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21;border:1px solid #dedfe3;border-radius:16px"><h2>确认邮箱</h2><p>点击下方按钮，确认此邮箱属于你。</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;border-radius:24px;background:#0866ff;color:#fff;text-decoration:none;font-weight:600">确认邮箱</a></p>${nativeHtml}<p style="color:#65676b;font-size:13px">30 分钟内有效。如果不是你发起的，请忽略此邮件。</p></div>`});
}

/** Ownership of the currently bound mailbox authorizes an email change. */
export async function sendAccountEmailChangeCode(to: string, code: string, permit: MailPermit) {
  const config = getMailConfig();
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  consumeMailPermit(to,"verification",permit);
  await createMailTransport(config).sendMail({
    from: {name:config.fromName || "Alcor",address:config.fromEmail}, to,
    subject: "Alcor 修改邮箱验证码",
    text: `你正在修改 Alcor 绑定邮箱。验证码：${code}\n五分钟内有效，只能使用一次。请勿向任何人提供验证码。如果不是你发起的，请忽略此邮件。`
  });
}
