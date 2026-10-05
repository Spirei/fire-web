import { mailBrandBanner } from "@/lib/mailBranding";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const data = await mailBrandBanner();
    return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("邮件品牌图片暂不可用", { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
