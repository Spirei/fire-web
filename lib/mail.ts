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

export async function sendRegistrationCode(to: string, code: string, permit: MailPermit) {
  const config = getMailConfig();
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  consumeMailPermit(to, "verification", permit);
  const rendered = configuredMailTemplate("registration", {email: to, siteName: config.fromName || "Alcor", minutes: 30, code});
  await createMailTransport(config).sendMail({from: {name: config.fromName || "Alcor", address: config.fromEmail}, to, ...rendered, attachments: [await mailBannerAttachment()]});
}

/** Recipient has already been checked against the owner's verified email by the worker. */
export async function sendPriceAlertEmail(to: string, event: Record<string, unknown>) {
  const config = getMailConfig();
  if (!config.host || !config.fromEmail) throw new Error("邮件服务未配置");
  const isTest = event.kind === "test";
  const sessions: Record<string, string> = {PRE:"盘前",REGULAR:"盘中",AFTER:"盘后",OVERNIGHT:"夜盘"};
  if (!isTest && (typeof event.name !== "string" || typeof event.code !== "string" || !["US","HK","CN"].includes(String(event.market)) || !["above","below"].includes(String(event.direction)) || !sessions[String(event.session)] || typeof event.target !== "string" || typeof event.price !== "number" || !Number.isFinite(event.price) || event.price <= 0 || !Number.isSafeInteger(event.createdAt) || Number(event.createdAt) <= 0)) throw new Error("股价提醒事件无效");
  const timeZone = event.market === "US" ? "America/New_York" : event.market === "HK" ? "Asia/Hong_Kong" : "Asia/Shanghai";
  const rendered = configuredMailTemplate(isTest ? "test" : "price_alert", {
    email:to, siteName:config.fromName || "Alcor", minutes:0,
    stockName:String(event.name ?? ""), stockCode:String(event.code ?? ""), market:String(event.market ?? ""),
    currentPrice:isTest ? "" : new Intl.NumberFormat("en-US", {useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:6}).format(Number(event.price)),
    targetPrice:String(event.target ?? ""), currency:String(event.currency ?? ""), direction:event.direction === "above" ? "涨至" : "跌至",
    session:sessions[String(event.session)] || "", quoteTime:String(event.quoteTime ?? ""),
    triggerTime:isTest ? "" : new Intl.DateTimeFormat("zh-CN", {timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",timeZoneName:"short"}).format(new Date(Number(event.createdAt)))
  });
  consumeMailPermit(to, "price_alert");
  const result = await createMailTransport(config).sendMail({from:{name:config.fromName || "Alcor",address:config.fromEmail},to,...rendered,attachments:[await mailBannerAttachment()]});
  if (!result.accepted?.length || result.rejected?.length) throw new Error("邮件服务未确认接收");
}
