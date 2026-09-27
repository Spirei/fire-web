import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

/** Fixed system resource, independent of uploaded assets and host volume overrides. */
export function GET() {
  const relative = "feature/passkey/通行密钥PASSKEY.png";
  for (const root of ["resource-default", "public/uploads"]) {
    try {
      const bytes = fs.readFileSync(path.join(process.cwd(), root, relative));
      return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=0, must-revalidate", "X-Content-Type-Options": "nosniff" } });
    } catch { /* Missing volume: try the bundled source, then the UI's vector fallback. */ }
  }
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}
