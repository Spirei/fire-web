"use client";
import AppSelect from "@/components/AppSelect";
import { useEffect, useState, type ReactNode } from "react";
import { useSitePalette } from "@/components/PaletteProvider";
import { useThemePreference } from "@/components/ThemePreferenceProvider";
import { usePersistedState } from "@/lib/usePersistedState";
import { SITE_PALETTES } from "@/lib/palettes";
import { APPEARANCE_ACCENTS } from "@/lib/appearance";
const KEY = "fire:platform-appearance";
const defaults = { width: "960", align: "left", font: "system", contentFont: "same", size: 14, contentSize: 14, weight: "400", contentWeight: "400", reduced: false, separate: false, translucent: true, contrast: 45, pointer: false, bg: "", ink: "", lightBg: "", lightInk: "", darkBg: "", darkInk: "" };
const fonts = { system: '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif', inter: 'Inter,-apple-system,"PingFang SC",sans-serif', serif: 'Georgia,"Songti SC",serif', mono: 'Menlo,"SFMono-Regular",monospace' };
export function PlatformAppearanceRuntime({ children }: {
    children: ReactNode;
}) {
    const [prefs] = usePersistedState(KEY, defaults);
    const { palette, accent } = useSitePalette();
    const { mode } = useThemePreference();
    useEffect(() => {
        const root = document.documentElement;
        const apply = () => {
            const dark = root.classList.contains('dark');
            const selected = SITE_PALETTES.find(p => p.id === palette)!;
            const channel = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ');
            const bg = prefs.separate ? (dark ? prefs.darkBg : prefs.lightBg) : prefs.bg, ink = prefs.separate ? (dark ? prefs.darkInk : prefs.lightInk) : prefs.ink;
            for (const [name, value, index] of [['bg', bg, 0], ['ink', ink, 2]] as const)
                root.style.setProperty(`--site-${name}-${dark ? 'dark' : 'light'}`, channel(/^#[0-9a-f]{6}$/i.test(value) ? value : selected[dark ? 'dark' : 'light'][index]));
            root.style.setProperty('--platform-ui-size', `${Math.max(12, Math.min(20, prefs.size))}px`);
            root.style.setProperty('--platform-content-size', `${Math.max(12, Math.min(24, prefs.contentSize))}px`);
            root.style.setProperty('--platform-font', fonts[prefs.font as keyof typeof fonts] || fonts.system);
            root.style.setProperty('--platform-content-font', prefs.contentFont === 'same' ? 'var(--platform-font)' : fonts[prefs.contentFont as keyof typeof fonts] || fonts.system);
            root.style.setProperty('--platform-weight', prefs.weight);
            root.style.setProperty('--platform-content-weight', prefs.contentWeight);
            root.style.setProperty('--platform-content-width', prefs.width === 'full' ? 'none' : `${prefs.width}px`);
            root.dataset.platformAlign = prefs.align;
            root.dataset.platformReduced = String(prefs.reduced);
            root.dataset.platformPointer = String(prefs.pointer);
            root.dataset.platformTranslucent = String(prefs.translucent);
            root.style.setProperty('--platform-edge', `color-mix(in srgb,rgb(var(--site-ink)) ${8 + prefs.contrast * .09}%,rgb(var(--site-bg)))`);
        };
        apply();
        const observer = new MutationObserver(apply);
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, [prefs, palette, accent, mode]);
    return <>{children}</>;
}
export default function PlatformAppearance() {
    const { palette, choose, accent, chooseAccent } = useSitePalette(), { mode, choose: chooseMode } = useThemePreference();
    const [prefs, set] = usePersistedState(KEY, defaults);
    const [advanced, setAdvanced] = useState(false);
    const [dark, setDark] = useState(mode === "dark");
    useEffect(() => { const sync = () => setDark(document.documentElement.classList.contains('dark')); sync(); const o = new MutationObserver(sync); o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); return () => o.disconnect(); }, []);
    const update = (key: keyof typeof defaults, value: string | number | boolean) => set(p => ({ ...p, [key]: value }));
    const theme = SITE_PALETTES.find(p => p.id === palette)!;
    const bgKey = prefs.separate ? (dark ? 'darkBg' : 'lightBg') : 'bg', inkKey = prefs.separate ? (dark ? 'darkInk' : 'lightInk') : 'ink';
    const select = (label: string, value: string, choices: readonly (readonly [
        string,
        string
    ])[], change: (value: string) => void) => <AppSelect ariaLabel={label} value={value} options={choices.map(([value, label]) => ({ value, label }))} onChange={change} className="platform-appearance-select"/>;
    const row = (label: string, control: ReactNode) => <div className="platform-appearance-row"><span>{label}</span><div>{control}</div></div>;
    const toggle = (key: 'reduced' | 'separate' | 'translucent' | 'pointer', label: string) => <button type="button" role="switch" aria-label={label} aria-checked={prefs[key]} data-capsule="off" onClick={() => update(key, !prefs[key])} className="platform-appearance-switch"><i /></button>;
    const fontOptions = [['system', '系统'], ['inter', 'Inter'], ['serif', '衬线'], ['mono', '等宽']] as const;
    const color = (label: string, key: 'bg' | 'ink' | 'lightBg' | 'lightInk' | 'darkBg' | 'darkInk', fallback: string) => <label className="platform-color"><input type="color" aria-label={label} value={prefs[key] || fallback} onChange={e => update(key, e.target.value)}/><span>{(prefs[key] || fallback).toUpperCase()}</span></label>;
    return <section className="platform-appearance-page" aria-label="外观"><h2>视觉风格</h2><div className="platform-appearance-card">{row('模式', <div className="platform-mode-options">{([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([v, label]) => <button key={v} type="button" data-capsule="off" aria-pressed={mode === v} onClick={() => chooseMode(v)}><span className={`platform-mode-preview ${v}`}><i /><b /><em /></span><small>{label}</small></button>)}</div>)}</div>
 <div className="platform-appearance-card">{row('主题', select('主题', palette, SITE_PALETTES.map(p => [p.id, p.name]), v => choose(v as typeof palette)))}{row('强调色', <AppSelect ariaLabel="强调色" value={accent} options={APPEARANCE_ACCENTS.map(a => ({value:a.id,label:a.name,swatch:a.color}))} onChange={v => chooseAccent(v as typeof accent)} className="platform-appearance-select"/>)}{row('背景', color('背景', bgKey, theme[dark ? 'dark' : 'light'][0]))}{row('前景', color('前景', inkKey, theme[dark ? 'dark' : 'light'][2]))}{row('字体', select('字体', prefs.font, fontOptions, v => update('font', v)))}</div>
 <h2>页面布局</h2><div className="platform-appearance-card">{row('内容宽度', select('内容宽度', prefs.width, [['960', '紧凑 · 960 px'], ['1140', '标准 · 1140 px'], ['1440', '宽阔 · 1440 px'], ['full', '全宽']], v => update('width', v)))}{row('内容对齐', <div className="platform-align-options">{[['left', '靠左'], ['center', '居中']].map(([v, t]) => <button type="button" data-capsule="off" aria-pressed={prefs.align === v} key={v} onClick={() => update('align', v)}>{t}</button>)}</div>)}</div>
 <button type="button" className="platform-advanced" data-capsule="off" aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}>高级 {advanced ? '⌃' : '⌄'}</button>
 {advanced && <><div className="platform-appearance-card">{row('界面字号', <label><input type="number" aria-label="界面字号" min={12} max={20} value={prefs.size} onChange={e => update('size', Number(e.target.value))}/> px</label>)}{row('内容字体大小', <label><input type="number" aria-label="内容字体大小" min={12} max={24} value={prefs.contentSize} onChange={e => update('contentSize', Number(e.target.value))}/> px</label>)}</div>
 <div className="platform-appearance-card">{row('减少动态效果', toggle('reduced', '减少动态效果'))}{row('分别设置浅色和深色模式', toggle('separate', '分别设置浅色和深色模式'))}</div>
 <div className="platform-appearance-card">{row('界面字体样式', select('界面字体样式', prefs.weight, [['400', '常规'], ['500', '中等'], ['600', '加粗']], v => update('weight', v)))}{row('内容字体', <>{select('内容字体', prefs.contentFont, [['same', '与界面字体相同'], ...fontOptions], v => update('contentFont', v))}{select('内容字体样式', prefs.contentWeight, [['400', '常规'], ['500', '中等'], ['600', '加粗']], v => update('contentWeight', v))}</>)}{row('半透明侧边栏', toggle('translucent', '半透明侧边栏'))}{row('对比度', <label><input type="range" aria-label="对比度" min={0} max={100} value={prefs.contrast} onChange={e => update('contrast', Number(e.target.value))}/><output>{prefs.contrast}</output></label>)}</div><div className="platform-appearance-card">{row('使用指针光标', toggle('pointer', '使用指针光标'))}</div></>}
 </section>;
}
