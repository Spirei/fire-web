import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getSiteSettings } from "@/lib/settings";

export const runtime = "nodejs";

export async function GET() {
  const source = getSiteSettings().ico;
  if (!source.startsWith("/uploads/ico/")) return new Response(null, { status: 404 });
  let name: string;
  try { name = decodeURIComponent(source.slice("/uploads/ico/".length)); }
  catch { return new Response(null, { status: 404 }); }
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return new Response(null, { status: 404 });

  for (const root of [path.join(process.cwd(), "public", "uploads", "ico"), path.join(process.cwd(), "resource-default", "ico")]) {
    try {
      const original = await fs.readFile(path.join(root, name));
      const icon = await sharp(original).resize(64, 64, { fit: "contain", background: "transparent", withoutEnlargement: true }).png().toBuffer();
      return new Response(new Uint8Array(icon), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" }
      });
    } catch { /* 仅尝试已配置图标在允许目录中的原文件。 */ }
  }
  return new Response(null, { status: 404 });
}
