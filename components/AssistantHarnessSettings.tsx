"use client";

import { useEffect, useState } from "react";
import { IconAdjustmentsHorizontal, IconDatabaseCog, IconMoon, IconRobot, IconSettings, IconSun, IconTrash, IconX } from "@tabler/icons-react";

export type AssistantAppearance = "light" | "dark" | "system";
export type AssistantDensity = "compact" | "comfortable";
type ServiceDraft = { id:string; name:string; provider:string; apiUrl:string; apiKey:string; apiKeyConfigured?:boolean; models:string[]; icon?:string };

export default function AssistantHarnessSettings({ open, section, appearance, fontSize, density, models = [], selectedModel = "auto", onClose, onSection, onAppearance, onFontSize, onDensity, onSelectModel, onModelsSaved }: {
  open: boolean;
  section: "general" | "models" | "plugins" | "preset";
  appearance: AssistantAppearance;
  fontSize: number;
  density: AssistantDensity;
  onClose: () => void;
  onSection: (section: "general" | "models" | "plugins" | "preset") => void;
  onAppearance: (value: AssistantAppearance) => void;
  onFontSize: (value: number) => void;
  onDensity: (value: AssistantDensity) => void;
  models?: Array<{ serviceId:string; serviceName:string; model:string; configured:boolean; health?:{ok:boolean}|null }>;
  selectedModel?: string;
  onSelectModel?: (value:string) => void;
  onModelsSaved?: () => void;
}) {
  const [editingModels,setEditingModels]=useState(false);
  const [services,setServices]=useState<ServiceDraft[]>([]);
  const [saving,setSaving]=useState(false);
  const [saveMessage,setSaveMessage]=useState("");
  useEffect(()=>{if(!open||section!=="models")return;void fetch("/api/settings").then(r=>r.ok?r.json():null).then(data=>{const rows=data?.settings?.modelServices;if(Array.isArray(rows))setServices(rows);}).catch(()=>undefined);},[open,section]);
  const updateService=(id:string,patch:Partial<ServiceDraft>)=>setServices(current=>current.map(item=>item.id===id?{...item,...patch}:item));
  const saveModels=async()=>{setSaving(true);setSaveMessage("");try{const response=await fetch("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({modelServices:services})});if(!response.ok)throw new Error();setEditingModels(false);setSaveMessage("模型服务已保存");onModelsSaved?.();}catch{setSaveMessage("保存失败，请重试");}finally{setSaving(false);}};
  if (!open) return null;
  const nav = [
    ["general", "通用设置", IconSettings],
    ["models", "模型", IconDatabaseCog],
    ["plugins", "插件", IconAdjustmentsHorizontal],
    ["preset", "助手预设", IconRobot],
  ] as const;
  return <div className="harness-settings-overlay" role="dialog" aria-modal="true" aria-label="设置">
    <button type="button" className="harness-settings-mask" aria-label="关闭设置" onClick={onClose} />
    <section className="harness-settings-panel">
      <aside className="harness-settings-nav">
        <h2>设置</h2>
        <div>{nav.map(([key,label,Icon]) => <button key={key} type="button" aria-current={section===key || undefined} onClick={()=>onSection(key)}><Icon size={18}/><span>{label}</span></button>)}</div>
      </aside>
      <main className="harness-settings-content">
        <header>{section==="models"&&<button type="button" className="harness-config-button" onClick={()=>setEditingModels(value=>!value)}>{editingModels?"取消编辑":"配置模型服务"}</button>}<button type="button" onClick={onClose} aria-label="关闭"><IconX size={21}/></button></header>
        <div className="harness-settings-options">
          {section === "general" && <>
            <SettingRow title="数据权限" desc="选择新对话默认发送的数据范围"><span className="harness-setting-pill">账户摘要</span></SettingRow>
            <SettingRow title="语言"><span className="harness-setting-pill">中文</span></SettingRow>
            <div className="harness-setting-block"><div className="harness-setting-title">外观</div><div className="harness-theme-cubes">
              {(["light","dark","system"] as AssistantAppearance[]).map(value => { const Icon=value==="light"?IconSun:value==="dark"?IconMoon:IconSettings; return <button type="button" key={value} className={appearance===value?"selected":""} onClick={()=>onAppearance(value)}><Icon size={20}/><span>{value==="light"?"浅色":value==="dark"?"深色":"跟随系统"}</span></button>; })}
            </div></div>
            <SettingRow title="字号大小" desc="仅影响会话内容的字号"><span className="harness-number-control"><button type="button" onClick={()=>onFontSize(Math.max(12,fontSize-1))}>−</button><b>{fontSize}</b><button type="button" onClick={()=>onFontSize(Math.min(18,fontSize+1))}>＋</button><em>px</em></span></SettingRow>
            <SettingRow title="对话显示" desc="控制已完成轮次的过程内容"><button type="button" className="harness-setting-pill" onClick={()=>onDensity(density==="compact"?"comfortable":"compact")}>{density==="compact"?"紧凑":"舒适"}</button></SettingRow>
            <SettingRow title="繁忙时的发送行为" desc="模型回答时输入新问题会排队发送"><span className="harness-setting-pill">排队发送</span></SettingRow>
          </>}
          {section === "models" && <><h3>模型</h3><p className="harness-section-intro">直接复用“模型服务”中配置的提供方和模型，所有操作都在当前弹窗完成。</p>{editingModels?<div className="harness-inline-model-editor">{services.map(service=><article key={service.id}><div className="harness-inline-model-head"><b>{service.name||"未命名服务"}</b><button type="button" onClick={()=>setServices(current=>current.filter(item=>item.id!==service.id))} disabled={services.length===1} aria-label="删除模型服务"><IconTrash size={16}/></button></div><label><span>服务名称</span><input value={service.name} onChange={event=>updateService(service.id,{name:event.target.value})}/></label><label><span>API 地址</span><input value={service.apiUrl} onChange={event=>updateService(service.id,{apiUrl:event.target.value})}/></label><label><span>API 密钥</span><input type="password" value={service.apiKey||""} placeholder={service.apiKeyConfigured?"已配置，留空不会覆盖":"输入 API Key"} onChange={event=>updateService(service.id,{apiKey:event.target.value})}/></label><label><span>模型 ID</span><textarea rows={2} value={service.models.join("\n")} onChange={event=>updateService(service.id,{models:event.target.value.split("\n")})}/></label></article>)}<button type="button" className="harness-add-provider" onClick={()=>setServices(current=>[...current,{id:`assistant-model-${Date.now().toString(36)}`,name:"新模型服务",provider:"custom",apiUrl:"",apiKey:"",models:[""]}])}>＋ 添加模型服务</button><button type="button" className="harness-model-save" disabled={saving} onClick={()=>void saveModels()}>{saving?"保存中…":"保存"}</button>{saveMessage&&<p className="harness-model-message">{saveMessage}</p>}</div>:<><div className="harness-model-settings-list"><button type="button" className={selectedModel==="auto"?"selected":""} onClick={()=>onSelectModel?.("auto")}><div><b>自动选择模型</b><span>按模型服务顺序自动回退</span></div>{selectedModel==="auto"&&<IconCheckmark/>}</button>{models.filter(model=>model.configured).map(model=>{const value=`${model.serviceId}:${model.model}`;return <button type="button" key={value} className={selectedModel===value?"selected":""} onClick={()=>onSelectModel?.(value)}><div><b>{model.model}</b><span>{model.serviceName}</span></div><i className={model.health?.ok===false?"error":""}/>{selectedModel===value&&<IconCheckmark/>}</button>})}</div><button type="button" className="harness-add-provider" onClick={()=>setEditingModels(true)}>＋ 管理模型服务</button>{saveMessage&&<p className="harness-model-message">{saveMessage}</p>}</>}</>}
          {section === "plugins" && <><h3>插件</h3><p className="harness-section-intro">智能助手能力已按现有 Fire 功能适配。</p>{["账户数据与当前页面","图片与附件","对话记忆","模型运行轨迹"].map(x=><div className="harness-plugin-card" key={x}><b>{x}</b><span>已启用</span></div>)}</>}
          {section === "preset" && <><h3>助手预设</h3><p className="harness-section-intro">决定新对话使用的数据和回答方式。</p>{["投资分析","数据检查","简洁回答"].map((x,i)=><button type="button" className={`harness-preset-card ${i===0?"selected":""}`} key={x}><b>{x}</b><span>{i===0?"默认":"可选"}</span></button>)}</>}
        </div>
      </main>
    </section>
  </div>;
}

function IconCheckmark(){return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 4 4L19 6"/></svg>}

function SettingRow({ title, desc, children }: { title:string; desc?:string; children:React.ReactNode }) {
  return <div className="harness-setting-row"><div><div className="harness-setting-title">{title}</div>{desc&&<p>{desc}</p>}</div><div>{children}</div></div>;
}
