export const PLATFORM_APPEARANCE_KEY = "fire:platform-appearance";
export const PLATFORM_FONTS = { system: '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif', inter: 'Inter,-apple-system,"PingFang SC",sans-serif', serif: 'Georgia,"Songti SC",serif', mono: 'Menlo,"SFMono-Regular",monospace' };
export function platformAppearanceServer(raw: unknown) {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const size = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(12, Math.min(max, value)) : 14;
    const font = (value: unknown) => PLATFORM_FONTS[value as keyof typeof PLATFORM_FONTS] || PLATFORM_FONTS.system;
    const weight = (value: unknown) => ['400', '500', '600'].includes(String(value)) ? String(value) : '400';
    const style: Record<string, string> = { '--platform-ui-size': `${size(p.size, 20)}px`, '--platform-content-size': `${size(p.contentSize, 24)}px`, '--platform-font': font(p.font), '--platform-content-font': p.contentFont === 'same' || !p.contentFont ? 'var(--platform-font)' : font(p.contentFont), '--platform-weight': weight(p.weight), '--platform-content-weight': weight(p.contentWeight), '--platform-content-width': ['960', '1140', '1440'].includes(String(p.width)) ? `${p.width}px` : p.width === "full" ? "none" : "960px" };
    for (const mode of ['light', 'dark'])
        for (const [name, key] of [['bg', 'Bg'], ['ink', 'Ink']]) {
            const value = p.separate ? p[mode + key] : p[name];
            if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
                style[`--site-${name}-${mode}`] = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)).join(' ');
        }
    return { style, align: p.align === 'center' ? 'center' : 'left', reduced: String(p.reduced === true), pointer: String(p.pointer === true), translucent: String(p.translucent !== false) };
}
