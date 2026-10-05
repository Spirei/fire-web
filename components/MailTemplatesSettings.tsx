"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import AppSelect from "./AppSelect";
import { DEFAULT_MAIL_TEMPLATES, MAIL_TEMPLATE_FIELDS, type MailTemplate, type MailTemplateId, type MailTemplateTextField } from "@/lib/mailTemplateModel";
const labels:Record<MailTemplateTextField,string>={subject:"邮件主题",title:"标题",greeting:"称呼",body:"正文",valueLabel:"验证码 / 操作名称",closing:"结束语",signature:"落款"};
export default function MailTemplatesSettings(){
  const [templates,setTemplates]=useState<MailTemplate[]>([]),[selected,setSelected]=useState<MailTemplateId>("email_change"),[drafts,setDrafts]=useState<Record<string,MailTemplate>>({}),[preview,setPreview]=useState(""),[subject,setSubject]=useState(""),[mobile,setMobile]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const previewSequence=useRef(0), mounted=useRef(true),canvasRef=useRef<HTMLDivElement>(null);
  const [canvasWidth,setCanvasWidth]=useState(0);
  const [brandingRevision,setBrandingRevision]=useState(0);
  useEffect(()=>{const refresh=()=>setBrandingRevision(value=>value+1);window.addEventListener("fire:settings-updated",refresh);return()=>window.removeEventListener("fire:settings-updated",refresh);},[]);
  const template=drafts[selected] || templates.find(t=>t.id===selected);
  const hasTemplate=Boolean(template);
  useLayoutEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const measure=()=>{const style=getComputedStyle(canvas);setCanvasWidth(Math.max(1,canvas.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)));};
    measure();const observer=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width)setCanvasWidth(width);});observer.observe(canvas);return()=>observer.disconnect();
  },[hasTemplate]);
  const frameWidth=mobile?Math.min(390,canvasWidth || 390):640;
  const previewScale=mobile?1:Math.min(1,(canvasWidth || 640)/640);
  useEffect(()=>{mounted.current=true;const abort=new AbortController();fetch("/api/settings/mail-templates",{cache:"no-store",signal:abort.signal}).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error || "读取失败");if(mounted.current)setTemplates(data.templates);}).catch(e=>{if(e.name!=="AbortError"&&mounted.current)setError(e.message);});return()=>{mounted.current=false;abort.abort();};},[]);
  useEffect(()=>{
    if(!template)return;
    const sequence=++previewSequence.current,abort=new AbortController();setPreview("");setSubject("");
    const timer=setTimeout(()=>{fetch("/api/settings/mail-templates/preview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(template),signal:abort.signal}).then(async r=>{const data=await r.json();if(!r.ok)throw Error(data.error || "预览失败");if(sequence===previewSequence.current&&mounted.current){setPreview(data.html);setSubject(data.subject);setError("");}}).catch(e=>{if(e.name!=="AbortError"&&sequence===previewSequence.current&&mounted.current)setError(e.message);});},200);
    return()=>{clearTimeout(timer);abort.abort();};
  },[template,brandingRevision]);
  function change(field:MailTemplateTextField,value:string){if(template){setDrafts(prev=>({...prev,[selected]:{...template,[field]:value}}));setMessage("");}}
  async function save(){
    if(!template || busy)return;setBusy(true);setMessage("");setError("");
    const saving=template;
    try{const r=await fetch("/api/settings/mail-templates",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(saving)}),data=await r.json();if(!r.ok)throw Error(data.error || "保存失败");if(!mounted.current)return;setTemplates(data.templates);setDrafts(prev=>{const next={...prev};if(next[saving.id]===saving)delete next[saving.id];return next;});setMessage("模板已保存");}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:"保存失败");}finally{if(mounted.current)setBusy(false);}
  }
  return <div className="mail-template-settings" data-preview={mobile?"mobile":"desktop"}>
    <div className="mail-template-toolbar"><div className="mail-template-preview-switch" role="group" aria-label="预览尺寸"><button type="button" aria-pressed={mobile} onClick={()=>setMobile(true)}>手机</button><button type="button" aria-pressed={!mobile} onClick={()=>setMobile(false)}>桌面</button></div><AppSelect ariaLabel="邮件模板" value={selected} options={DEFAULT_MAIL_TEMPLATES.map(t=>({value:t.id,label:t.name}))} onChange={v=>{setSelected(v as MailTemplateId);setMessage("");}} className="btn btn-line" disabled={busy}/></div>
    {error&&<p className="settings-form-feedback is-err" role="alert">{error}</p>}{message&&<p className="settings-form-feedback is-ok" role="status">{message}</p>}
    {template&&<div className="mail-template-grid"><div className="mail-template-editor"><fieldset disabled={busy}>{MAIL_TEMPLATE_FIELDS.map(field=><label key={field}><span>{labels[field]}</span>{field==="body"?<textarea rows={5} maxLength={1600} value={template[field]} onChange={e=>change(field,e.target.value)}/>:<input maxLength={160} value={template[field]} onChange={e=>change(field,e.target.value)}/>}</label>)}</fieldset><p className="mail-template-variables">变量：{"{{email}}"}、{"{{minutes}}"}、{"{{name}}"}、{"{{siteName}}"}</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" className="btn btn-line" disabled={busy} onClick={()=>{const preset=DEFAULT_MAIL_TEMPLATES.find(t=>t.id===selected)!;setDrafts(prev=>({...prev,[selected]:{...preset}}));setMessage("");}}>恢复默认</button><button type="button" className="btn btn-line" disabled={busy||!drafts[selected]} onClick={()=>void save()}>{busy?"保存中…":"保存模板"}</button></div></div><div className="mail-template-preview"><p className="mail-template-subject">{subject || "正在生成预览…"}</p><div className="mail-template-canvas" ref={canvasRef}><div className="mail-template-frame" style={{width:frameWidth*previewScale,height:780*previewScale}}><iframe title={`${template.name}邮件预览`} sandbox="" srcDoc={preview} style={{width:frameWidth,transform:`scale(${previewScale})`}}/></div></div></div></div>}
  </div>;
}
