import { isPersonalFontId, type PersonalFontId } from "./personal-font-id.ts";
type Store = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const prefix = "alcor.personal-font-request:",
  uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const personalFontLimit = 10485760;
export type PersonalFont = {
  id: PersonalFontId;
  name: string;
  sha256: string;
  size: number;
  mediaType: string;
  contentPath: string;
  originalPath: string;
};
export type FontListing = {
  fonts: PersonalFont[];
  revision: number;
  maxBytes: number;
  maxFonts: number;
  formats: string[];
};
export type FontReceipt = {
  requestId: string;
  kind: "upload";
  state: "completed" | "failed";
  httpStatus: number;
  revision: number;
  message: string;
  deduplicated?: boolean;
  font?: PersonalFont;
  canceled?: boolean;
};
export function fontOperationId(value: string) {
  return uuid.test(value);
}
export function clearFontRequests(s: Store, keep?: string) {
  for (const k of Array.from({ length: s.length }, (_, i) => s.key(i)))
    if (k?.startsWith(prefix) && k !== prefix + keep) s.removeItem(k);
}
export function readFontRequest(s: Store, scope: string) {
  clearFontRequests(s, scope);
  const id = s.getItem(prefix + scope);
  if (id !== null && !uuid.test(id)) throw new Error("原字体操作编号无法读取");
  return id;
}
export function retainFontRequest(s: Store, scope: string, id: string) {
  if (!uuid.test(id)) throw new Error("字体操作编号无效");
  const old = readFontRequest(s, scope);
  if (old && old !== id) throw new Error("请先核对原字体操作");
  s.setItem(prefix + scope, id);
}
export function releaseFontRequest(s: Store, scope: string, id: string) {
  if (s.getItem(prefix + scope) === id) s.removeItem(prefix + scope);
}
export function personalFont(raw: unknown): PersonalFont {
  const v = raw as PersonalFont | null;
  if (
    !v ||
    !isPersonalFontId(v.id) ||
    typeof v.name !== "string" ||
    !v.name ||
    v.name.length > 60 ||
    /[\x00-\x1f\x7f]/.test(v.name) ||
    !Number.isSafeInteger(v.size) ||
    v.size < 48 ||
    v.size > personalFontLimit ||
    !/^[a-f0-9]{64}$/.test(v.sha256)
  )
    throw new Error("本人字体与原件待核对");
  const match = v.id.match(/-([a-f0-9]{64})\.(woff2?|ttf|otf)$/)!;
  const path = "/api/personal-fonts/" + v.id;
  if (
    match[1] !== v.sha256 ||
    v.mediaType !== "font/" + match[2] ||
    v.contentPath !== path + "/content" ||
    v.originalPath !== path + "/original"
  )
    throw new Error("字体摘要、类型或地址不符");
  return v;
}
export function fontListing(raw: unknown): FontListing {
  const v = raw as FontListing | null;
  if (
    !v ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !Array.isArray(v.fonts) ||
    v.fonts.length > 20 ||
    v.maxBytes !== personalFontLimit ||
    v.maxFonts !== 20 ||
    !Array.isArray(v.formats) ||
    v.formats.length !== 4 ||
    new Set(v.formats).size !== 4 ||
    v.formats.some((x) => !["woff", "woff2", "ttf", "otf"].includes(x))
  )
    throw new Error("本人字体列表范围待核对");
  for (const font of v.fonts) personalFont(font);
  if (new Set(v.fonts.map((f) => f.id)).size !== v.fonts.length)
    throw new Error("字体列表有重复编号");
  return v;
}
export function fontReceipt(raw: unknown, id: string): FontReceipt {
  const v = raw as FontReceipt | null;
  if (
    !v ||
    !uuid.test(id) ||
    v.requestId !== id ||
    v.kind !== "upload" ||
    !["completed", "failed"].includes(v.state) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    typeof v.message !== "string" ||
    (v.state === "completed"
      ? v.httpStatus !== 200
      : !Number.isInteger(v.httpStatus) ||
        v.httpStatus < 400 ||
        v.httpStatus > 599)
  )
    throw new Error("原字体回执待核对");
  if (v.state === "completed") {
    personalFont(v.font);
    if (typeof v.deduplicated !== "boolean" || v.canceled)
      throw new Error("字体完成回执不符");
  }
  return v;
}
export function fontForm(file: File, id: string, revision: number) {
  if (!uuid.test(id) || !Number.isSafeInteger(revision) || revision < 0)
    throw new Error("请先读取当前字体修订");
  if (file.size < 48 || file.size > personalFontLimit)
    throw new Error("字体不能超过 10 MB");
  if (!/\.(woff2?|ttf|otf)$/i.test(file.name))
    throw new Error("请选择 WOFF2、WOFF、TTF 或 OTF 字体");
  const form = new FormData();
  form.append("file", file);
  form.append("requestId", id);
  form.append("expectedRevision", String(revision));
  return form;
}
