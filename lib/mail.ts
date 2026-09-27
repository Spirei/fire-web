import nodemailer from "nodemailer";
import { getSiteSettings } from "./settings";

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
    fromName: settings.smtpFromName || process.env.SMTP_FROM_NAME || "Fire",
    fromEmail: settings.smtpFromEmail || process.env.SMTP_FROM_EMAIL || ""
  };
}

export type MailConfigInput = Partial<ReturnType<typeof getMailConfig>>;

function resolveMailConfig(input?: MailConfigInput) {
  const saved = getMailConfig();
  if (!input) return saved;
  const port = Number(input.port ?? saved.port);
  return {
    host: String(input.host ?? saved.host).trim(),
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : saved.port,
    secure: typeof input.secure === "boolean" ? input.secure : saved.secure,
    user: String(input.user ?? saved.user).trim(),
    password: input.password ? String(input.password) : saved.password,
    fromName: String(input.fromName ?? saved.fromName).trim(),
    fromEmail: String(input.fromEmail ?? saved.fromEmail).trim()
  };
}

export function mailConfigured() {
  const config = getMailConfig();
  return Boolean(config.host && config.fromEmail);
}

export async function sendPasswordResetEmail(input: { to: string; name: string; resetUrl: string; minutes: number }) {
  const config = getMailConfig();
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  });
  const siteName = config.fromName || "Fire";
  const safeName = escapeHtml(input.name || "你好");
  const safeUrl = escapeHtml(input.resetUrl);
  await transport.sendMail({
    from: { name: siteName, address: config.fromEmail },
    to: input.to,
    subject: `重置你的 ${siteName} 密码`,
    text: `${input.name || "你好"}，请在 ${input.minutes} 分钟内打开以下链接重置密码：\n\n${input.resetUrl}\n\n如果不是你发起的，请忽略此邮件。`,
    html: `<div style="max-width:560px;margin:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21"><h2 style="font-size:22px">重置密码</h2><p>${safeName}，我们收到了密码重置请求。</p><p><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#0866ff;color:#fff;text-decoration:none;font-weight:700">设置新密码</a></p><p style="color:#65676b;font-size:13px">链接将在 ${input.minutes} 分钟后失效且只能使用一次。如果不是你发起的，请忽略此邮件。</p></div>`
  });
}

export async function sendTestEmail(to: string, input?: MailConfigInput) {
  const config = resolveMailConfig(input);
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置完整");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000
  });
  await transport.sendMail({
    from: { name: config.fromName || "Fire", address: config.fromEmail },
    to,
    subject: "Fire 邮件服务测试",
    text: "邮件服务配置成功。你现在可以使用邮箱自助找回密码。",
    html: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif"><h2>配置成功</h2><p>你现在可以使用邮箱自助找回密码。</p></div>'
  });
}
