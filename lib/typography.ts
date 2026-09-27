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
export type SiteFont = typeof SITE_FONTS[number]["id"] | `custom-${string}`;
export type UploadedFont = { id: SiteFont; name: string };
export const CUSTOM_FONT_PATTERN = /^custom-[1-9]\d*-[a-f0-9]{64}\.(woff2?|ttf|otf)$/;
export function customFontCss(id: unknown) {
  if (typeof id !== "string" || !CUSTOM_FONT_PATTERN.test(id)) return "";
  return `@font-face{font-family:"${id}";src:url("/uploads/fonts/${id}");font-display:swap;font-weight:100 900;}`;
}
export const FONT_WEIGHTS = [{ value: 400, name: "常规" }, { value: 500, name: "适中" }, { value: 700, name: "加粗" }] as const;
export type SiteFontWeight = typeof FONT_WEIGHTS[number]["value"];
export function resolveFont(id: unknown): { id: SiteFont; name: string; family: string } {
  if (typeof id === "string" && CUSTOM_FONT_PATTERN.test(id)) return { id: id as SiteFont, name: "自定义字体", family: `"${id}", ${chinese}` };
  return SITE_FONTS.find(font => font.id === id) || SITE_FONTS[0];
}
export function resolveFontWeight(value: unknown): SiteFontWeight { return FONT_WEIGHTS.find(weight => weight.value === value)?.value || 400; }
export function typographyVariables(font: unknown, weight: unknown): CSSProperties & Record<string, string> {
  return { "--site-font-family": resolveFont(font).family, "--site-entry-weight": String(resolveFontWeight(weight)) };
}
