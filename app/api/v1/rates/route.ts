import { getRates, quotedCurrencies, ratesUpdatedAt, refreshRates } from "@/lib/rates";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 汇率（?refresh=1 强制刷新，兜底用上次成功汇率） */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const rates = force ? await refreshRates() : await getRates();
    return ok({ base: "USD", rates, quoted: quotedCurrencies(), updatedAt: ratesUpdatedAt() });
  } catch {
    return fail(50002, "获取汇率失败，请稍后重试", 502);
  }
}
