"use client";

import { IconAdjustmentsHorizontal, IconDatabaseCog, IconMoon, IconRobot, IconSettings, IconSun, IconX } from "@tabler/icons-react";

export type AssistantAppearance = "light" | "dark" | "system";
export type AssistantDensity = "compact" | "comfortable";

export default function AssistantHarnessSettings({ open, section, appearance, fontSize, density, onClose, onSection, onAppearance, onFontSize, onDensity, onOpenModels }: {
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
  onOpenModels: () => void;
}) {
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
        <header><button type="button" className="harness-config-button" onClick={onOpenModels}>打开模型服务</button><button type="button" onClick={onClose} aria-label="关闭"><IconX size={21}/></button></header>
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
          {section === "models" && <><h3>模型</h3><p className="harness-section-intro">使用“模型服务”中已配置的提供方和模型。</p><div className="harness-provider-card"><span>当前模型服务</span><i/><button type="button" onClick={onOpenModels}>编辑</button></div><button type="button" className="harness-add-provider" onClick={onOpenModels}>＋ 管理模型服务</button></>}
          {section === "plugins" && <><h3>插件</h3><p className="harness-section-intro">智能助手能力已按现有 Fire 功能适配。</p>{["账户数据与当前页面","图片与附件","对话记忆","模型运行轨迹"].map(x=><div className="harness-plugin-card" key={x}><b>{x}</b><span>已启用</span></div>)}</>}
          {section === "preset" && <><h3>助手预设</h3><p className="harness-section-intro">决定新对话使用的数据和回答方式。</p>{["投资分析","数据检查","简洁回答"].map((x,i)=><button type="button" className={`harness-preset-card ${i===0?"selected":""}`} key={x}><b>{x}</b><span>{i===0?"默认":"可选"}</span></button>)}</>}
        </div>
      </main>
    </section>
  </div>;
}

function SettingRow({ title, desc, children }: { title:string; desc?:string; children:React.ReactNode }) {
  return <div className="harness-setting-row"><div><div className="harness-setting-title">{title}</div>{desc&&<p>{desc}</p>}</div><div>{children}</div></div>;
}
