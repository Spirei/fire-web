import { configuredMailTemplate, mailBannerAttachment } from "./mailTemplates";
import nodemailer from "nodemailer";
import { getSiteSettings } from "./settings";
import { consumeMailPermit, type MailPermit } from "./mailBudget";
import { normalizeProductName } from "./brand";
import { sameSmtpDestination, SmtpDestinationError } from "./smtpConfig";

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
  const rendered=configuredMailTemplate("password_reset",{email:input.to,name:input.name,siteName:config.fromName || "Alcor",code:input.code,minutes:input.minutes});
  await transport.sendMail({from:{name:config.fromName || "Alcor",address:config.fromEmail},to:input.to,...rendered,attachments:[await mailBannerAttachment()]});
}

export async function sendTestEmail(to: string, input?: MailConfigInput) {
  const config = resolveMailConfig(input);
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置完整");
  consumeMailPermit(to, "test");
  const transport = createMailTransport(config);
  const rendered=configuredMailTemplate("test",{email:to,siteName:config.fromName || "Alcor",minutes:0});
  await transport.sendMail({from:{name:config.fromName || "Alcor",address:config.fromEmail},to,...rendered,attachments:[await mailBannerAttachment()]});
}

export async function sendEmailVerification(to: string, url: string, permit?: MailPermit, nativeToken?: string) {
  const config=getMailConfig();
  if(!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  consumeMailPermit(to, "verification", permit);
  const transport=createMailTransport(config);
  const rendered=configuredMailTemplate("email_verification",{email:to,siteName:config.fromName || "Alcor",minutes:30,url,nativeToken});
  await transport.sendMail({from:{name:config.fromName || "Alcor",address:config.fromEmail},to,...rendered,attachments:[await mailBannerAttachment()]});
}

/** Ownership of the currently bound mailbox authorizes an email change. */
export async function sendAccountEmailChangeCode(to: string, code: string, permit: MailPermit) {
  const config = getMailConfig();
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  consumeMailPermit(to,"verification",permit);
  const rendered=configuredMailTemplate("email_change",{email:to,siteName:config.fromName || "Alcor",minutes:30,code});
  await createMailTransport(config).sendMail({from:{name:config.fromName || "Alcor",address:config.fromEmail},to,...rendered,attachments:[await mailBannerAttachment()]});
}
