export type PersonalFontId = `custom-${string}`;
const pattern = /^custom-[1-9][0-9]*-([a-f0-9]{64})\.(woff2?|ttf|otf)$/;
export function isPersonalFontId(value: unknown): value is PersonalFontId {
  return (
    typeof value === "string" && value.length <= 128 && pattern.test(value)
  );
}
export function personalFontFamily(value: string, preview = false) {
  const match = value.match(pattern);
  if (!isPersonalFontId(value) || !match) throw new Error("字体编号无法核对");
  return "alcor-personal-" + (preview ? "preview-" : "font-") + match[1];
}
