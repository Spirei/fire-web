import type { CSSProperties } from "react";
export const FONT_KEY = "fire:appearance-font";
export const FONT_WEIGHT_KEY = "fire:appearance-font-weight";
const chinese = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
export const SITE_FONTS = [
  { id: "system", name: "系统默认", family: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", ${chinese}` },
  { id: "apple", name: "苹果 · SF Pro", family: `"SF Pro Display", -apple-system, BlinkMacSystemFont, ${chinese}` },
  { id: "rounded", name: "圆润 · Diatype", family: `"AWS Diatype Rounded Semi Mono", ${chinese}` },
  { id: "classic", name: "经典 · Arial", family: `Arial, "Helvetica Neue", ${chinese}` },
] as const;
export type SiteFont = typeof SITE_FONTS[number]["id"];
export const FONT_WEIGHTS = [{ value: 400, name: "常规" }, { value: 500, name: "适中" }, { value: 700, name: "加粗" }] as const;
export type SiteFontWeight = typeof FONT_WEIGHTS[number]["value"];
export function resolveFont(id: unknown) { return SITE_FONTS.find(font => font.id === id) || SITE_FONTS[0]; }
export function resolveFontWeight(value: unknown): SiteFontWeight { return FONT_WEIGHTS.find(weight => weight.value === value)?.value || 400; }
export function typographyVariables(font: unknown, weight: unknown): CSSProperties & Record<string, string> {
  return { "--site-font-family": resolveFont(font).family, "--site-entry-weight": String(resolveFontWeight(weight)) };
}
