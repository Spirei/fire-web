import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { CUSTOM_FONT_PATTERN, type UploadedFont, type SiteFont } from "./typography";
export const FONT_MAX_BYTES = 10 * 1024 * 1024;
const ROOT = path.join(process.cwd(), "public", "uploads", "fonts");
export function listCustomFonts(uid: number): UploadedFont[] {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT).filter(id => CUSTOM_FONT_PATTERN.test(id) && id.startsWith(`custom-${uid}-`)).map(id => {
    let name = "自定义字体";
    try { name = JSON.parse(fs.readFileSync(path.join(ROOT, `${id}.json`), "utf8")).name || name; } catch {}
    return { id: id as SiteFont, name };
  });
}
export function validateFont(bytes: Buffer, ext: string) {
  if (!bytes.length || bytes.length > FONT_MAX_BYTES) throw new Error("字体不能超过 10 MB");
  const magic = bytes.subarray(0, 4).toString("hex");
  const expected: Record<string, string> = { woff: "774f4646", woff2: "774f4632", ttf: "00010000", otf: "4f54544f" };
  if (bytes.length < 48 || expected[ext] !== magic) throw new Error("请选择有效的字体文件");
  if (ext.startsWith("woff")) {
    if (bytes.readUInt32BE(8) !== bytes.length || bytes.readUInt16BE(12) === 0 || bytes.readUInt32BE(16) > 100 * 1024 * 1024) throw new Error("字体文件无效");
  } else {
    const count = bytes.readUInt16BE(4);
    if (!count || count > 256 || 12 + count * 16 > bytes.length) throw new Error("字体文件无效");
    for (let i = 0; i < count; i++) {
      const offset = bytes.readUInt32BE(12 + i * 16 + 8), length = bytes.readUInt32BE(12 + i * 16 + 12);
      if (offset + length > bytes.length) throw new Error("字体文件无效");
    }
  }
}
export function saveCustomFont(uid: number, filename: string, bytes: Buffer): UploadedFont {
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("账户编号无效");
  const ext = path.extname(filename).slice(1).toLowerCase();
  validateFont(bytes, ext);
  const id = `custom-${uid}-${createHash("sha256").update(bytes).digest("hex")}.${ext}` as SiteFont;
  const fonts = listCustomFonts(uid);
  const existing = fonts.find(font => font.id === id);
  if (existing) return existing;
  if (fonts.length >= 20) throw new Error("最多上传 20 款字体");
  const name = path.basename(filename, path.extname(filename)).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 60) || "自定义字体";
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, `${id}.json`), JSON.stringify({ name }), { flag: "wx" });
  try { fs.writeFileSync(path.join(ROOT, id), bytes, { flag: "wx" }); }
  catch (error) { fs.unlinkSync(path.join(ROOT, `${id}.json`)); throw error; }
  return { id, name };
}
