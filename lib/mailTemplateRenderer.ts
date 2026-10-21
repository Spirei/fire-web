import { mailTemplateVariables, type MailTemplate, type PRICE_ALERT_TEMPLATE_VARIABLES } from "./mailTemplateModel";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export type MailTemplateValues = { email: string; siteName: string; minutes: number; name?: string; code?: string; url?: string; nativeToken?: string } & Partial<Record<typeof PRICE_ALERT_TEMPLATE_VARIABLES[number], string>>;

/** Shared by SMTP, administrator previews and App template discovery. Editable fields are plain text. */
export function renderMailTemplate(template: MailTemplate, values: MailTemplateValues, bannerSrc = "cid:alcor-mail-banner") {
  const priceAlert = template.id === "price_alert";
  const tones = priceAlert ? {link:"#333333", muted:"#777777", value:"#161616", action:"#161616", hint:"#777777", body:"#333333", title:"#111111", panel:"#f5f5f5", border:"#e7e7e7", signature:"#777777", divider:"#e5e5e5", signatureInk:"#333333"} : {link:"#137f78", muted:"#4e6d66", value:"#163b33", action:"#143f36", hint:"#63716c", body:"#35443f", title:"#172f29", panel:"#f1f8f4", border:"#dcece3", signature:"#5d7068", divider:"#e5ede8", signatureInk:"#213e34"};
  const fill = (text: string) => text.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (slot, field: string) => mailTemplateVariables(template.id).includes(field) ? String(values[field as keyof MailTemplateValues] ?? "") : slot);
  const textField = (field: string) => escape(fill(field)).replace(/\n/g, "<br>");
  const email = escape(values.email);
  // Generate the mailbox link from the actual recipient, never from editable HTML.
  const body = textField(template.body);
  const paragraph = email ? body.split(email).join(`<a href="mailto:${email}" style="color:${tones.link};text-decoration:underline">${email}</a>`) : body;
  const label = `<div class="mail-value-label" style="font-size:15px;line-height:1.5;color:${tones.muted};margin-bottom:20px">${textField(template.valueLabel)}</div>`;
  let value = "";
  if (priceAlert) {
    value = `${label}<div class="mail-alert-price" style="font-size:36px;line-height:1.25;font-weight:600;color:${tones.value};font-variant-numeric:tabular-nums;overflow-wrap:anywhere">${escape(values.currentPrice || "—")}<span style="font-size:14px;font-weight:400;margin-left:7px;color:${tones.muted}">${escape(values.currency || "")}</span></div><div style="font-size:14px;line-height:1.6;color:${tones.muted};margin-top:10px">提醒价 ${escape(values.targetPrice || "—")}</div>`;
  } else if (template.kind === "code") {
    if (!/^\d{6}$/.test(values.code || "")) throw new Error("验证码格式无效");
    value = `${label}<div class="mail-code" style="font-size:46px;line-height:1.25;letter-spacing:8px;font-weight:600;color:${tones.value};font-variant-numeric:tabular-nums">${values.code}</div>`;
  } else if (template.kind === "link") {
    const url = new URL(values.url || "");
    if (!["https:", ...(process.env.NODE_ENV !== "production" ? ["http:"] : [])].includes(url.protocol) || url.username || url.password) throw new Error("验证链接无效");
    value = `<a href="${escape(url.href)}" style="display:inline-block;background:${tones.action};border-radius:10px;padding:15px 30px;font-size:17px;line-height:1.4;font-weight:600;color:#fff;text-decoration:none">${textField(template.valueLabel)}</a>`;
  } else value = `<div style="font-size:22px;line-height:1.5;font-weight:600;color:${tones.value}">${textField(template.valueLabel)}</div>`;
  const token = values.nativeToken ? `<p style="font-size:13px;line-height:1.8;word-break:break-all;margin-top:24px;color:${tones.hint}">也可在 Alcor App 的邮箱验证页粘贴一次性凭证：<br>${escape(values.nativeToken)}</p>` : "";
  const greeting = priceAlert ? "" : `<p class="mail-copy" style="overflow-wrap:anywhere;font-size:17px;line-height:1.85;margin:0 0 18px">${textField(template.greeting)}</p>`;
  const metadata = priceAlert ? `<p style="font-size:13px;line-height:1.7;color:${tones.muted};margin:18px 0 0;text-align:center">${escape([values.session,values.triggerTime].filter(Boolean).join(" · "))}</p>` : "";
  const signature = priceAlert ? `<div class="mail-signature" style="font-size:14px;line-height:1.8;margin-top:30px;padding-top:20px;border-top:1px solid ${tones.divider};color:${tones.signature}">${textField(template.signature)}</div>` : `<div class="mail-signature" style="font-size:15px;line-height:1.8;margin-top:38px;padding-top:24px;border-top:1px solid ${tones.divider};color:${tones.signature}"><p style="margin:0 0 8px">${textField(template.closing)}</p><p style="margin:0;font-weight:600;color:${tones.signatureInk}">${textField(template.signature)}</p></div>`;
  const dark = (selector: string, css: string) => {
    const parts = selector.split(",").map((item) => item.trim());
    const scope = (prefix: string) => parts.map((item) => `${prefix} ${item}`).join(",");
    return `${scope("html.dark")},${scope("html[data-theme=dark]")}{${css}}@media (prefers-color-scheme:dark){${scope("html:not([data-theme=light])")}{${css}}}`;
  };
  const darkCss = [
    dark("body", "background:#171a19!important;color:#d7e4df!important"),
    dark(".mail-title", "color:#f4f7f6!important"),
    dark(".mail-copy", "color:#d7e4df!important"),
    dark(".mail-copy a", "color:#5dcec4!important"),
    dark(".mail-value", "background:#24302c!important;border-color:#345048!important"),
    dark(".mail-value-label,.mail-code,.mail-alert-price", "color:#e7f4ef!important"),
    dark(".mail-alert-price span", "color:#9eb2aa!important"),
    dark(".mail-signature", "color:#9eb2aa!important;border-color:#2c3b36!important"),
    dark(".mail-signature p", "color:#e7f4ef!important")
  ].join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>@media(max-width:480px){.mail-container{padding:20px 18px!important}.mail-body{padding:26px 8px 0!important}.mail-title{font-size:25px!important;margin-bottom:28px!important}.mail-copy{font-size:16px!important}.mail-value{padding:26px 12px!important}.mail-code{font-size:35px!important;letter-spacing:5px!important}.mail-alert-price{font-size:32px!important}.mail-signature{margin-top:32px!important}}${darkCss}</style></head><body style="margin:0;background:#fff;color:${tones.body};font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;table-layout:fixed"><tr><td class="mail-container" style="padding:36px 38px"><img class="mail-banner" src="${escape(bannerSrc)}" alt="${priceAlert ? "Alcor" : "Alcor 账户安全"}" width="564" style="display:block;width:100%;height:auto;border-radius:12px"><div class="mail-body" style="padding:38px 16px 0"><h1 class="mail-title" style="font-size:30px;line-height:1.35;font-weight:600;letter-spacing:.5px;color:${tones.title};margin:0 0 34px">${textField(template.title)}</h1>${greeting}<p class="mail-copy" style="overflow-wrap:anywhere;font-size:17px;line-height:1.85;margin:0 0 28px">${paragraph}</p><div class="mail-value" style="padding:30px 16px 34px;background:${tones.panel};border:1px solid ${tones.border};border-radius:14px;text-align:center">${value}</div>${token}${metadata}${signature}</div></td></tr></table></td></tr></table></body></html>`;
  return {
    subject: fill(template.subject).replace(/[\r\n]/g, " "), html,
    text: (priceAlert ? [fill(template.title),fill(template.body),`${fill(template.valueLabel)} ${values.currentPrice || "—"} ${values.currency || ""}`,`提醒价 ${values.targetPrice || "—"}`,[values.session,values.triggerTime].filter(Boolean).join(" · "),fill(template.signature)] : [fill(template.title), fill(template.greeting), fill(template.body), fill(template.valueLabel), values.code || values.url || "", values.nativeToken ? `Alcor App 一次性凭证：${values.nativeToken}` : "", fill(template.closing), fill(template.signature)]).filter(Boolean).join("\n\n")
  };
}
