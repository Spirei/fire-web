import { NextRequest, NextResponse } from "next/server";
import { resolveManagedImage } from "@/lib/managedAssetImages";
import { GET as serveUpload } from "@/app/uploads/[...path]/route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const image = resolveManagedImage(key);
  if (!image) return new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const headers = { "Cache-Control": "public, no-cache", ETag: image.etag };
  if (!request.headers.has('range') && request.headers.get('if-none-match') === image.etag) return new NextResponse(null, { status: 304, headers });
  const response = await serveUpload(request, { params: Promise.resolve({ path: decodeURIComponent(image.url.slice(9)).split('/') }) });
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}
