import { platformRequest } from "@/lib/platformTransport";
export const dynamic = "force-dynamic";
const names = new Set([
  "pwa-icon",
  "site-favicon",
  "mail-banner",
  "passkey",
  "security-check",
]);
export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> },
) {
  const { name } = await context.params;
  if (!names.has(name)) return new Response(null, { status: 404 });
  return platformRequest(
    `/assets/system/${name}${new URL(request.url).search}`,
    { headers: request.headers, signal: request.signal },
  );
}
