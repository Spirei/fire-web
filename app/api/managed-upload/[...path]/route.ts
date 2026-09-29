import { NextRequest } from "next/server";
import { resolveManagedAlias } from "@/lib/managedAssetImages";
import { GET as serveUpload } from "@/app/uploads/[...path]/route";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  if (!['asset', 'cards'].includes(params.path[0])) return new Response(null, { status: 404 });
  const image = resolveManagedAlias('/uploads/' + params.path.join('/'));
  const response = await serveUpload(request, { params: Promise.resolve(image ? { path: decodeURIComponent(image.url.slice(9)).split('/') } : params) });
  response.headers.set('Cache-Control', 'public, no-cache');
  if (image) response.headers.set('ETag', image.etag);
  return response;
}
