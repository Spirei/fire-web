import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

let cached: { key: string; href: string } | null = null;

/** Embed the configured tab icon in SSR metadata, so refreshing does not fetch it again. */
export async function initialSiteFavicon(source: string): Promise<string> {
  if (source === "/favicon.ico") return "/site-icon.svg";
  if (!source.startsWith("/uploads/ico/")) return source || "/site-icon.svg";
  let name: string;
  try { name = decodeURIComponent(source.slice("/uploads/ico/".length)); }
  catch { return "/site-icon.svg"; }
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return "/site-icon.svg";

  for (const root of [path.join(process.cwd(), "public", "uploads", "ico"), path.join(process.cwd(), "resource-default", "ico")]) {
    try {
      const file = path.join(root, name);
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      const key = `${file}:${stat.mtimeMs}:${stat.size}`;
      if (cached?.key === key) return cached.href;
      const png = await sharp(file).resize(32, 32, { fit: "contain", background: "transparent", withoutEnlargement: true }).png().toBuffer();
      const href = `data:image/png;base64,${png.toString("base64")}`;
      cached = { key, href };
      return href;
    } catch { /* Try the other allowed icon directory. */ }
  }
  return "/site-icon.svg";
}
