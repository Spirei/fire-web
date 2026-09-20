/** Shared site palette contract. Financial up/down colors are intentionally semantic. */
export const PALETTE_KEY = "fire:site-palette";
export const PALETTE_TOKENS = ["bg", "surface", "ink", "muted", "accent", "edge", "soft"] as const;
export const SITE_PALETTES = [
  { id: "neutral", name: "中性灰", note: "安静克制，让内容成为主角", glass: false,
    light: ["#f5f6f8", "#ffffff", "#20242c", "#606875", "#525d70", "#dce0e7", "#eceff3"],
    dark: ["#111318", "#1b1f27", "#edf0f6", "#aab2c0", "#bac7dd", "#343b47", "#282e39"] },
  { id: "liquid", name: "Liquid Glass", note: "通透银白，流动高光与玻璃层次", glass: true,
    light: ["#e9edf4", "#f8faff", "#202735", "#59687e", "#2d65b8", "#c7d2e3", "#dbe7f8"],
    dark: ["#101724", "#1d2a3c", "#eef5ff", "#afc0d8", "#9bc4ff", "#3a4d68", "#293f5d"] },
  { id: "ocean", name: "海盐蓝", note: "冷白与深海蓝，清晰而理性", glass: false,
    light: ["#eef5f9", "#fcfeff", "#16334a", "#526e83", "#176b99", "#c9dfe9", "#dfedf5"],
    dark: ["#0c1c29", "#142c3e", "#e6f5ff", "#9fbdce", "#79c9ed", "#2d4c60", "#1e4057"] },
  { id: "forest", name: "松林绿", note: "植物绿与亚麻白，自然平静", glass: false,
    light: ["#f0f4ee", "#fcfdf9", "#23392e", "#5b7163", "#2f7359", "#d1dfd3", "#e0ebe0"],
    dark: ["#111e19", "#1c2f26", "#edf5e9", "#abc1ae", "#9dccad", "#354e3d", "#2b4435"] },
  { id: "amber", name: "琥珀纸", note: "暖纸色与焦糖，柔和的阅读质感", glass: false,
    light: ["#f5efe4", "#fffcf5", "#3b2f24", "#78674f", "#955b25", "#e2d4bb", "#efe1c9"],
    dark: ["#221b15", "#30271e", "#faf0df", "#c8b79b", "#e7b877", "#514330", "#423422"] },
  { id: "dusk", name: "暮光紫", note: "雾紫与墨色，细腻而有个性", glass: false,
    light: ["#f2eef8", "#fdfaff", "#352847", "#736183", "#8053aa", "#ded1eb", "#eadef4"],
    dark: ["#1b1426", "#2b203a", "#f5ecff", "#c4acd8", "#cea4f1", "#493558", "#3c2b50"] },
] as const;
export type PaletteId = typeof SITE_PALETTES[number]["id"];
export function resolvePalette(value: unknown) { return SITE_PALETTES.find(p => p.id === value) ?? SITE_PALETTES[0]; }
export function paletteVariables(value: unknown): Record<string, string> {
  const palette = resolvePalette(value);
  const result: Record<string, string> = {};
  for (const mode of ["light", "dark"] as const) PALETTE_TOKENS.forEach((token, index) => {
    const hex = palette[mode][index];
    result[`--site-${token}-${mode}`] = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)).join(" ");
  });
  return result;
}
