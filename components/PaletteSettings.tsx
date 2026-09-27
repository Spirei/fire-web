"use client";
import { SITE_PALETTES } from "@/lib/palettes";
import { useSitePalette } from "./PaletteProvider";
import { APPEARANCE_ACCENTS } from "@/lib/appearance";
import { useThemePreference } from "./ThemePreferenceProvider";
import { IconSun, IconMoon, IconDeviceDesktop, IconCheck } from "@tabler/icons-react";
import TypographySettings, { TypographyPreview } from "./TypographySettings";
export default function PaletteSettings() {
  const { palette, choose, accent, chooseAccent } = useSitePalette();
  const { mode, choose: chooseMode } = useThemePreference();
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
      <div className="appearance-row appearance-colors-row"><span className="appearance-label">主题颜色</span>
        <div className="appearance-colors" role="group" aria-label="主题颜色">
          {APPEARANCE_ACCENTS.map(a => <button type="button" key={a.id} data-capsule="off" className="appearance-swatch" aria-label={a.name} title={a.name} aria-pressed={accent === a.id} style={{ "--swatch": a.color } as React.CSSProperties} onClick={() => chooseAccent(a.id)}>
            {accent === a.id && <span className="appearance-check"><IconCheck size={12} stroke={2.5}/></span>}
          </button>)}
        </div>
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
