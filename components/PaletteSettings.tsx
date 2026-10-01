"use client";
import { SITE_PALETTES } from "@/lib/palettes";
import { useSitePalette } from "./PaletteProvider";
import { APPEARANCE_ACCENTS } from "@/lib/appearance";
import { useThemePreference } from "./ThemePreferenceProvider";
import { IconSun, IconMoon, IconDeviceDesktop, IconCheck } from "@tabler/icons-react";
import TypographySettings, { TypographyPreview } from "./TypographySettings";
import { usePersistedState } from "@/lib/usePersistedState";
export default function PaletteSettings() {
  const { palette, choose, accent, chooseAccent } = useSitePalette();
  const { mode, choose: chooseMode } = useThemePreference();
  const [fourDoorEnabled, setFourDoorEnabled] = usePersistedState("fire:four-door-enabled", false);
  return <section id="palette" className="site-palette-settings">
    <header><div><h2>外观</h2></div></header>
    <TypographyPreview />
    <div className="appearance-card">
      <div className="appearance-row"><span className="appearance-label">模式</span>
        <div className="appearance-mode" role="group" aria-label="外观模式">
          {([{ id: "light", name: "浅色", Icon: IconSun }, { id: "dark", name: "深色", Icon: IconMoon }, { id: "system", name: "跟随系统", Icon: IconDeviceDesktop }] as const).map(({ id, name, Icon }) =>
            <button key={id} type="button" data-capsule="off" aria-label={name} title={name} aria-pressed={mode === id} onClick={() => chooseMode(id)}><Icon size={23} stroke={1.7}/></button>)}
        </div>
      </div>
      {palette === "muse" ? <div className="appearance-row"><span className="appearance-label">Muse 原色</span><span className="muse-color-note">蓝色链接 · 中性背景<br/>自选主题色在其他配色中保留</span></div> : <div className="appearance-row appearance-colors-row"><span className="appearance-label">主题颜色</span>
        <div className="appearance-colors" role="group" aria-label="主题颜色">
          {APPEARANCE_ACCENTS.map(a => <button type="button" key={a.id} data-capsule="off" className="appearance-swatch" aria-label={a.name} title={a.name} aria-pressed={accent === a.id} style={{ "--swatch": a.color } as React.CSSProperties} onClick={() => chooseAccent(a.id)}>
            {accent === a.id && <span className="appearance-check"><IconCheck size={12} stroke={2.5}/></span>}
          </button>)}
        </div>
      </div>}
      <div className="appearance-row">
        <div><span className="appearance-label">四色门</span><p id="four-door-description" className="mt-1 text-xs text-muted">在桌面侧栏显示快捷导航</p></div>
        <button type="button" role="switch" aria-label="四色门" aria-describedby="four-door-description" aria-checked={fourDoorEnabled === true} onClick={() => setFourDoorEnabled(value => value !== true)}
          className={`relative h-5 w-9 flex-none rounded-full transition-colors duration-300 ease-out ${fourDoorEnabled === true ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}>
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow transition-transform duration-300 ${fourDoorEnabled === true ? "translate-x-4" : ""}`} style={{ backgroundColor: "#fff", transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }} />
        </button>
      </div>
    </div>
    <TypographySettings />
    <details className="appearance-more"><summary>更多配色</summary>
    <div className="site-palette-grid">
      {SITE_PALETTES.map(p => <button type="button" key={p.id} aria-pressed={palette === p.id} onClick={() => choose(p.id)} className="site-palette-option">
        <span className="site-palette-preview" style={{ background: p.light[0], color: p.light[2] }}>
          <span className="site-palette-mini-side" style={{ background: p.light[6] }}><i style={{ background: p.light[4] }} /><i /><i /></span>
          <span className="site-palette-mini-card" style={{ background: p.glass ? "#ffffff70" : p.light[1], borderColor: p.light[5] }}><i style={{ background: p.light[4] }} /><i /><i /></span>
          <span className="site-palette-night" style={{ background: p.dark[1], borderColor: p.dark[5] }}><i style={{ background: p.dark[4] }} /></span>
        </span>
        <span className="site-palette-name">{p.name}<span>{palette === p.id ? "已选用" : "选择"}</span></span>
        <span className="site-palette-note">{p.note}</span>
      </button>)}
    </div>
    </details>
  </section>;
}
