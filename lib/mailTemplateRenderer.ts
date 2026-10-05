import type { MailTemplate } from "./mailTemplateModel";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export type MailTemplateValues = { email: string; siteName: string; minutes: number; name?: string; code?: string; url?: string; nativeToken?: string };

/** Shared by SMTP, administrator previews and App template discovery. Editable fields are plain text. */
export function renderMailTemplate(template: MailTemplate, values: MailTemplateValues, bannerSrc = "cid:alcor-mail-banner") {
  const fill = (text: string) => text.replace(/\{\{(email|siteName|minutes|name)\}\}/g, (_, field: keyof MailTemplateValues) => String(values[field] ?? ""));
  const textField = (field: string) => escape(fill(field)).replace(/\n/g, "<br>");
  const email = escape(values.email);
  // Generate the mailbox link from the actual recipient, never from editable HTML.
  const body = textField(template.body);
  const paragraph = email ? body.split(email).join(`<a href="mailto:${email}" style="color:#137f78;text-decoration:underline">${email}</a>`) : body;
  const label = `<div class="mail-value-label" style="font-size:15px;line-height:1.5;color:#4e6d66;margin-bottom:20px">${textField(template.valueLabel)}</div>`;
  let value = "";
  if (template.kind === "code") {
    if (!/^\d{6}$/.test(values.code || "")) throw new Error("验证码格式无效");
    value = `${label}<div class="mail-code" style="font-size:46px;line-height:1.25;letter-spacing:8px;font-weight:600;color:#163b33;font-variant-numeric:tabular-nums">${values.code}</div>`;
  } else if (template.kind === "link") {
    const url = new URL(values.url || "");
    if (!["https:", ...(process.env.NODE_ENV !== "production" ? ["http:"] : [])].includes(url.protocol) || url.username || url.password) throw new Error("验证链接无效");
    value = `<a href="${escape(url.href)}" style="display:inline-block;background:#143f36;border-radius:10px;padding:15px 30px;font-size:17px;line-height:1.4;font-weight:600;color:#fff;text-decoration:none">${textField(template.valueLabel)}</a>`;
  } else value = `<div style="font-size:22px;line-height:1.5;font-weight:600;color:#163b33">${textField(template.valueLabel)}</div>`;
  const token = values.nativeToken ? `<p style="font-size:13px;line-height:1.8;word-break:break-all;margin-top:24px;color:#63716c">也可在 Alcor App 的邮箱验证页粘贴一次性凭证：<br>${escape(values.nativeToken)}</p>` : "";
  const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>@media(max-width:480px){.mail-container{padding:20px 18px!important}.mail-body{padding:26px 8px 0!important}.mail-title{font-size:25px!important;margin-bottom:28px!important}.mail-copy{font-size:16px!important}.mail-value{padding:26px 12px!important}.mail-code{font-size:35px!important;letter-spacing:5px!important}.mail-signature{margin-top:32px!important}}</style></head><body style="margin:0;background:#fff;color:#35443f;font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%"><tr><td class="mail-container" style="padding:36px 38px"><img class="mail-banner" src="${escape(bannerSrc)}" alt="Alcor 账户安全" width="564" style="display:block;width:100%;height:auto;border-radius:12px"><div class="mail-body" style="padding:38px 16px 0"><h1 class="mail-title" style="font-size:30px;line-height:1.35;font-weight:600;letter-spacing:.5px;color:#172f29;margin:0 0 34px">${textField(template.title)}</h1><p class="mail-copy" style="font-size:17px;line-height:1.85;margin:0 0 18px">${textField(template.greeting)}</p><p class="mail-copy" style="font-size:17px;line-height:1.85;margin:0 0 28px">${paragraph}</p><div class="mail-value" style="padding:30px 16px 34px;background:#f1f8f4;border:1px solid #dcece3;border-radius:14px;text-align:center">${value}</div>${token}<div class="mail-signature" style="font-size:15px;line-height:1.8;margin-top:38px;padding-top:24px;border-top:1px solid #e5ede8;color:#5d7068"><p style="margin:0 0 8px">${textField(template.closing)}</p><p style="margin:0;font-weight:600;color:#213e34">${textField(template.signature)}</p></div></div></td></tr></table></td></tr></table></body></html>`;
  return {
    subject: fill(template.subject).replace(/[\r\n]/g, " "), html,
    text: [fill(template.title), fill(template.greeting), fill(template.body), fill(template.valueLabel), values.code || values.url || "", values.nativeToken ? `Alcor App 一次性凭证：${values.nativeToken}` : "", fill(template.closing), fill(template.signature)].filter(Boolean).join("\n\n")
  };
}
