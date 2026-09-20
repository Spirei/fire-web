"use client";
import { SITE_PALETTES } from "@/lib/palettes";
import { useSitePalette } from "./PaletteProvider";
import ThemeToggle from "./ThemeToggle";
export default function PaletteSettings() {
  const { palette, choose } = useSitePalette();
  return <section id="palette" className="site-palette-settings">
    <header><div><h2>全站配色</h2><p>从颜色到材质，首页、车型导入和后台保持一致。</p></div><ThemeToggle /></header>
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
    <p className="site-palette-foot">每套配色均支持深浅模式。选择即时生效并在当前浏览器保存；行情涨跌色保持原有含义。</p>
  </section>;
}
