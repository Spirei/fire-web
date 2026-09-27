"use client";
import AppSelect from "./AppSelect";
import { SITE_FONTS, FONT_WEIGHTS, resolveFont } from "@/lib/typography";
import { useTypography } from "./TypographyProvider";
import { SubNavIcon } from "./SettingsHeader";
export function TypographyPreview() {
  const { font, weight } = useTypography();
  return <div className="typography-preview" aria-label="字体实时预览" style={{ fontFamily: resolveFont(font).family, fontWeight: weight }}>
      <div className="typography-preview-chrome"><span className="typography-window-dots" aria-hidden="true"><i/><i/><i/></span></div>
      {/* Buffett's 1986 shareholder letter: https://www.berkshirehathaway.com/letters/1986.html */}
      <div className="typography-preview-content"><span className="typography-specimen" aria-hidden="true">Aa</span><div className="typography-preview-copy"><span className="typography-preview-title">别人贪婪时恐惧，</span><span>别人恐惧时贪婪。</span><span className="typography-preview-numbers">π 3.141592653589793…</span></div></div>
    </div>;
}
export default function TypographySettings() {
  const { font, weight, chooseFont, chooseWeight } = useTypography();
  return <section className="typography-settings" aria-label="字体设置">
    <div className="appearance-card typography-card">
      <div className="appearance-row"><span className="typography-label"><SubNavIcon name="typography" className="h-6 w-6"/><span>字体</span></span><AppSelect value={font} onChange={value => chooseFont(resolveFont(value).id)} options={SITE_FONTS.map(item => ({ value: item.id, label: item.name }))} className="typography-select" menuClassName="typography-select-menu" ariaLabel="字体"/></div>
      <div className="appearance-row"><span className="appearance-label">字重</span><div className="typography-weights" role="group" aria-label="文字字重">{FONT_WEIGHTS.map(item => <button type="button" data-capsule="off" key={item.value} aria-pressed={weight === item.value} onClick={() => chooseWeight(item.value)} style={{ fontWeight: item.value }}>{item.name}</button>)}</div></div>
    </div>
  </section>;
}
