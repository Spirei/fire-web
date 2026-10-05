import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDb } from "./db";
import { normalizeProductName } from "./brand";

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let cached: { key: string; data: Buffer } | undefined;
const defaultLogo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="26" fill="#000"/><g transform="translate(16 16) scale(1.25)" fill="none" stroke="#ffa600" stroke-linecap="round" stroke-linejoin="round"><path d="M14 13v38h38M15 37l12-12 12 12 14-18" stroke-width="5.5"/><path d="m43 18 12-3-3 12" fill="#ffa600" stroke-width="3.5"/></g></svg>');

/** Uploaded website artwork only. Never read arbitrary paths or fetch configured remote URLs. */
async function uploadedLogo(source: string) {
  const match = /^\/uploads\/(logo|ico)\/([^/?#]+)$/.exec(source);
  if (!match) return undefined;
  let name: string;
  try { name = decodeURIComponent(match[2]); } catch { return undefined; }
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name)) return undefined;
  const folder = path.join(process.cwd(), "public/uploads", match[1]);
  try {
    const root = await fs.realpath(folder), file = await fs.realpath(path.join(folder, name));
    if (!file.startsWith(root + path.sep)) return undefined;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return undefined;
    return { data: await fs.readFile(file), key: `${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` };
  } catch { return undefined; }
}

/** Snapshot the latest saved website logo; aspect ratio is preserved inside its banner area. */
export async function mailBrandBanner() {
  // Read these two public fields directly: other route bundles can retain their
  // own settings cache after an administrator replaces the artwork.
  const rows = getDb().prepare("SELECT key,value FROM site_settings WHERE key IN ('siteLogo','logoText')").all() as { key: string; value: string }[];
  const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
  const name = normalizeProductName((settings.logoText || "Alcor").trim()).slice(0, 32) || "Alcor";
  const artwork = await uploadedLogo(settings.siteLogo || "");
  const key = `${artwork?.key || "default"}:${name}`;
  if (cached?.key === key) return cached.data;
  let logo: Buffer;
  try { logo = await sharp(artwork?.data || defaultLogo, { limitInputPixels: 24_000_000 }).rotate().resize(148, 148, { fit: "contain", background: "transparent" }).png().toBuffer(); }
  catch { logo = await sharp(defaultLogo).resize(148, 148).png().toBuffer(); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="280"><defs><linearGradient id="b"><stop stop-color="#fbf2cd"/><stop offset=".48" stop-color="#79d7b8"/><stop offset="1" stop-color="#14b8b1"/></linearGradient></defs><rect width="1080" height="280" rx="24" fill="url(#b)"/><circle cx="865" cy="140" r="234" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="1.5"/><circle cx="914" cy="-8" r="146" fill="#fff" fill-opacity=".10"/><circle cx="937" cy="150" r="4" fill="#fcf4d8"/><path d="M630 280L865 45l180 235" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="1.5"/><text x="252" y="146" font-family="Arial,sans-serif" font-size="${Math.min(60, Math.floor(660 / Math.max(1, Array.from(name).length)))}" font-weight="600" letter-spacing="1.5" fill="#102c2a">${escape(name)}</text><text x="255" y="182" font-family="Arial,sans-serif" font-size="17" letter-spacing="5" fill="#224d45">ACCOUNT · SECURITY</text></svg>`;
  const data = await sharp(Buffer.from(svg)).composite([{ input: logo, left: 64, top: 66 }]).png().toBuffer();
  cached = { key, data };
  return data;
}
export const MAIL_BANNER_PATH = "/api/system-assets/mail-banner";
