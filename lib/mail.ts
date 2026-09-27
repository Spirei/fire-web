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

export async function sendPasswordResetEmail(input: { to: string; name: string; code: string; minutes: number }) {
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
  const safeCode = escapeHtml(input.code);
  await transport.sendMail({
    from: { name: siteName, address: config.fromEmail },
    to: input.to,
    subject: `${siteName} 密码重置验证码`,
    text: `${input.name || "你好"}，你的密码重置验证码是：\n\n${input.code}\n\n${input.minutes} 分钟内有效，只能使用一次。请勿向任何人提供验证码。如果不是你发起的，请忽略此邮件。`,
    html: `<div style="max-width:480px;margin:24px auto;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21;border:1px solid #dedfe3;border-radius:16px"><h2 style="margin:0 0 16px;font-size:22px">重置密码</h2><p>${safeName}，请在网页中输入以下验证码：</p><div style="margin:24px 0;padding:20px 8px;border-radius:12px;background:#f2f4f7;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;font-family:monospace">${safeCode}</div><p style="color:#65676b;font-size:13px;line-height:1.7">${input.minutes} 分钟内有效，只能使用一次。请勿向任何人提供验证码。<br>如果不是你发起的，请忽略此邮件。</p></div>`
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

export async function sendEmailVerification(to: string, url: string) {
  const config=getMailConfig();
  if(!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:config.secure,auth:config.user?{user:config.user,pass:config.password}:undefined,connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:15_000});
  await transport.sendMail({from:{name:config.fromName||"Fire",address:config.fromEmail},to,subject:`确认你的 ${config.fromName||"Fire"} 邮箱`,text:`请打开以下链接确认邮箱：\n\n${url}\n\n30 分钟内有效。如果不是你发起的，请忽略此邮件。`,html:`<div style="max-width:480px;margin:24px auto;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1e21;border:1px solid #dedfe3;border-radius:16px"><h2>确认邮箱</h2><p>点击下方按钮，确认此邮箱属于你。</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;border-radius:24px;background:#0866ff;color:#fff;text-decoration:none;font-weight:600">确认邮箱</a></p><p style="color:#65676b;font-size:13px">30 分钟内有效。如果不是你发起的，请忽略此邮件。</p></div>`});
}
