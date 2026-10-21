export const MAIL_TEMPLATE_IDS = ["email_change", "password_reset", "email_verification", "test", "registration", "price_alert"] as const;
export type MailTemplateId = typeof MAIL_TEMPLATE_IDS[number];
export type MailTemplate = {id:MailTemplateId;name:string;kind:"code"|"link"|"message";subject:string;title:string;greeting:string;body:string;valueLabel:string;closing:string;signature:string};
export const DEFAULT_MAIL_TEMPLATES: MailTemplate[] = [
  {id:"email_change",name:"修改邮箱验证码",kind:"code",subject:"{{siteName}} 修改邮箱验证码",title:"邮箱验证",greeting:"尊敬的客户：",body:"您的邮箱 {{email}} 申请修改绑定邮箱，该验证码 {{minutes}} 分钟内有效，请勿泄露给其他人。",valueLabel:"验证码",closing:"此致",signature:"{{siteName}}"},
  {id:"password_reset",name:"找回密码",kind:"code",subject:"{{siteName}} 密码重置验证码",title:"找回密码",greeting:"尊敬的客户：",body:"您的邮箱 {{email}} 申请重置密码，该验证码 {{minutes}} 分钟内有效，请勿泄露给其他人。",valueLabel:"验证码",closing:"此致",signature:"{{siteName}}"},
  {id:"email_verification",name:"邮箱验证",kind:"link",subject:"确认您的 {{siteName}} 邮箱",title:"邮箱验证",greeting:"尊敬的客户：",body:"您的邮箱 {{email}} 申请验证，请点击下方链接确认。该链接 {{minutes}} 分钟内有效，请勿转发给其他人。",valueLabel:"验证邮箱",closing:"此致",signature:"{{siteName}}"},
  {id:"test",name:"邮件服务测试",kind:"message",subject:"{{siteName}} 邮件服务测试",title:"邮件服务测试",greeting:"尊敬的客户：",body:"邮件服务已连接成功。您的邮箱 {{email}} 可以接收 {{siteName}} 的账户验证邮件。",valueLabel:"连接成功",closing:"此致",signature:"{{siteName}}"},
  {id:"registration",name:"邮箱注册验证码",kind:"code",subject:"{{siteName}} 注册验证码",title:"注册账户",greeting:"尊敬的客户：",body:"您的邮箱 {{email}} 申请注册账户，该验证码 {{minutes}} 分钟内有效，请勿泄露给其他人。",valueLabel:"验证码",closing:"此致",signature:"{{siteName}}"},
  {id:"price_alert",name:"股价提醒",kind:"message",subject:"{{siteName}} 股价提醒 · {{stockName}}",title:"{{stockName}} 股价提醒",greeting:"尊敬的客户：",body:"{{stockName}}（{{stockCode}} · {{market}}）已触及你设定的价格。\n触发时股价：{{currentPrice}} {{currency}}\n报价时段：{{session}}\n行情时间：{{quoteTime}}\n触发时间：{{triggerTime}}",valueLabel:"{{direction}} {{targetPrice}} {{currency}}",closing:"此致",signature:"{{siteName}}"}
];
export const MAIL_TEMPLATE_COMMON_VARIABLES = ["email", "minutes", "name", "siteName"] as const;
export const PRICE_ALERT_TEMPLATE_VARIABLES = ["stockName", "stockCode", "market", "currentPrice", "targetPrice", "currency", "direction", "session", "quoteTime", "triggerTime"] as const;
export function mailTemplateVariables(id: MailTemplateId): readonly string[] {
  return id === "price_alert" ? [...MAIL_TEMPLATE_COMMON_VARIABLES, ...PRICE_ALERT_TEMPLATE_VARIABLES] : MAIL_TEMPLATE_COMMON_VARIABLES;
}
export const MAIL_TEMPLATE_FIELDS = ["subject","title","greeting","body","valueLabel","closing","signature"] as const;
export type MailTemplateTextField = typeof MAIL_TEMPLATE_FIELDS[number];
/** Text-only editing: no executable HTML, transport settings or credential policy. */
export function validateMailTemplate(input:unknown):MailTemplate {
  if(!input || typeof input!=="object" || Array.isArray(input)) throw new Error("模板格式无效");
  const body=input as Record<string,unknown>, preset=DEFAULT_MAIL_TEMPLATES.find(t=>t.id===body.id);
  if(!preset || Object.keys(body).some(key=>!["id","name","kind",...MAIL_TEMPLATE_FIELDS].includes(key))) throw new Error("模板字段无效");
  const result={...preset};
  for(const field of MAIL_TEMPLATE_FIELDS){
    const value=body[field];
    if(typeof value!=="string" || !value.trim() || value.length>(field==="body"?1600:160) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw new Error("请填写完整模板，正文最多1600字，其他字段最多160字");
    if([...value.matchAll(/\{\{([^{}]+)\}\}/g)].some(match=>!mailTemplateVariables(preset.id).includes(match[1])))throw new Error("模板包含不支持的变量");
    result[field]=value.trim();
  }
  return result;
}
