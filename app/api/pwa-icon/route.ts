import sharp from "sharp";
import { getSiteSettings } from "@/lib/settings";
import { pwaArtwork } from "@/lib/pwaIcon";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const size = Number(params.get("size") || 192);
  if (![180, 192, 512].includes(size)) return new Response(null, { status: 400 });
  const settings = getSiteSettings();
  const artwork = await pwaArtwork(settings.pwaIcon || settings.ico);
  if (params.has("v") && params.get("v") !== artwork.version) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const png = size === 512 ? artwork.data : await sharp(artwork.data).resize(size, size).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-cache" } });
}
