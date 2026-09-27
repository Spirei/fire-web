import { SECURITY_CHECK_SVG } from "@/lib/securityIllustration";

// Preserve the legacy image URL even when the host's icons directory is empty.
export function GET() {
  return new Response(SECURITY_CHECK_SVG, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
