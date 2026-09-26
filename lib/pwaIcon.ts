import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

let cached: { key: string; data: Buffer; version: string } | undefined;
/** Local artwork only; no network requests to administrator-provided URLs. */
export async function pwaArtwork(source: string) {
  const files: string[] = [];
  if (source.startsWith("/uploads/ico/")) {
    let name = "";
    try { name = decodeURIComponent(source.slice("/uploads/ico/".length)); } catch {}
    if (name && name !== "." && name !== ".." && !/[\\/]/.test(name)) files.push(path.join(process.cwd(), "public/uploads/ico", name), path.join(process.cwd(), "resource-default/ico", name));
  }
  files.push(path.join(process.cwd(), "public/site-icon.svg"));
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      const key = `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (cached?.key === key) return cached;
      const data = await sharp(await fs.readFile(file)).resize(512, 512, { fit: "contain", background: "#0a0e19" }).png().toBuffer();
      cached = { key, data, version: createHash("sha256").update(data).digest("hex").slice(0, 24) };
      return cached;
    } catch { /* Invalid uploads fall back to bundled artwork. */ }
  }
  throw new Error("PWA icon unavailable");
}
export const pwaIconUrl = (version: string, size: number) => `/api/pwa-icon?v=${version}&size=${size}`;
