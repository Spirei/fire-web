export const ACCENT_KEY = "fire:appearance-accent";
export const APPEARANCE_ACCENTS = [
  { id: "blue", name: "蓝色", color: "#0866ff", ink: "#ffffff" },
  { id: "sky", name: "天蓝", color: "#0084eb", ink: "#ffffff" },
  { id: "deep", name: "深蓝", color: "#0064d9", ink: "#ffffff" },
  { id: "purple", name: "紫色", color: "#9654cf", ink: "#ffffff" },
  { id: "pink", name: "玫红", color: "#d90087", ink: "#ffffff" },
  { id: "orange", name: "橙色", color: "#ba6300", ink: "#ffffff" },
  { id: "green", name: "绿色", color: "#4b7900", ink: "#ffffff" },
  { id: "brown", name: "暖灰", color: "#8e7358", ink: "#ffffff" },
  { id: "white", name: "白色", color: "#ffffff", ink: "#1c1e21" },
] as const;
export type AppearanceAccent = typeof APPEARANCE_ACCENTS[number]["id"];
export function resolveAccent(value: unknown) { return APPEARANCE_ACCENTS.find(a => a.id === value) ?? APPEARANCE_ACCENTS[0]; }
export function accentVariables(value: unknown): Record<string, string> {
  const accent = resolveAccent(value);
  const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(" ");
  const rgb = channels(accent.color);
  return { "--site-action": accent.color, "--site-action-text": accent.ink, "--site-action-icon-filter": accent.id === "white" ? "brightness(0)" : "brightness(0) invert(1)", "--site-action-hover": `color-mix(in srgb, ${accent.color} 90%, #000)`, "--site-accent-light": accent.id === "white" ? channels("#65676b") : rgb, "--site-accent-dark": accent.id === "white" ? channels("#e4e6eb") : rgb };
}
