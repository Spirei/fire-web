/**
 * 左上角 LOGO 文字字体选项（设置 → 网站形象 → Logo 字体）
 * - diatype：AWS Diatype Rounded Semi Mono Bold（kiro.dev 同款 · 粗体，默认）
 * - diatype-regular：AWS Diatype Rounded Semi Mono Regular（kiro.dev 同款 · 常规）
 * - system：系统粗体（font-extrabold，历史默认外观）
 */
export type LogoFontOption = "diatype" | "diatype-regular" | "system";

export const LOGO_FONT_LABELS: Record<LogoFontOption, string> = {
  diatype: "KIRO 同款 · 粗体",
  "diatype-regular": "KIRO 同款 · 常规",
  system: "系统粗体"
};

export function logoFontClass(font: string | undefined | null): string {
  if (font === "diatype-regular") return "font-logo font-normal";
  if (font === "system") return "font-extrabold";
  return "font-logo font-bold";
}
