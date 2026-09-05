import { NextRequest } from "next/server";
import { xlsxBuffer, type XlsxInvest } from "@/lib/simpleLedgerXlsx";

export const runtime = "nodejs";

/** POST { invest: XlsxInvest[] } → 返回「有知有行投资记账」xlsx 附件 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const invest = Array.isArray(body?.invest) ? (body.invest as XlsxInvest[]) : [];
  if (!invest.length) {
    return new Response(JSON.stringify({ ok: false, error: "没有可导出的投资账户" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const buf = xlsxBuffer(invest);
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const filename = `fire-simple-invest-${day}.xlsx`;

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
