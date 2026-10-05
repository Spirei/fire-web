import { renderMailTemplate, type MailTemplateValues } from "./mailTemplateRenderer";
export { renderMailTemplate } from "./mailTemplateRenderer";
import { mailBrandBanner } from "./mailBranding";
import { getDb } from "./db";
import { DEFAULT_MAIL_TEMPLATES, validateMailTemplate, type MailTemplate, type MailTemplateId } from "./mailTemplateModel";
const key="mailTemplates.v1";
export function readMailTemplates():MailTemplate[] {
  const saved=getDb().prepare("SELECT value FROM site_settings WHERE key=?").get(key) as {value:string}|undefined;
  try {
    const entries=JSON.parse(saved?.value || "[]");
    if(!Array.isArray(entries))return DEFAULT_MAIL_TEMPLATES.map(t=>({...t}));
    return DEFAULT_MAIL_TEMPLATES.map(preset=>{const item=entries.find(t=>t?.id===preset.id);try{return item?validateMailTemplate(item):{...preset};}catch{return {...preset};}});
  } catch{return DEFAULT_MAIL_TEMPLATES.map(t=>({...t}));}
}
export function saveMailTemplate(input:unknown){
  const template=validateMailTemplate(input),db=getDb();
  return db.transaction(()=>{
    const templates=readMailTemplates().map(t=>t.id===template.id?template:t);
    db.prepare("INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(templates));
    return templates;
  }).immediate();
}
export function configuredMailTemplate(id:MailTemplateId,values:MailTemplateValues){return renderMailTemplate(readMailTemplates().find(t=>t.id===id)!,values);}
export async function mailBannerAttachment(){return {filename:"alcor-banner.png",content:await mailBrandBanner(),cid:"alcor-mail-banner",contentType:"image/png"};}
export function mailTemplatesDiscovery(version:1|2){return {version:1,path:`/api/v${version}/auth/mail-templates`,template_ids:DEFAULT_MAIL_TEMPLATES.map(t=>t.id),style:"alcor-brand-v1"};}
