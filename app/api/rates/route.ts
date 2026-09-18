import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getRates, quotedCurrencies, ratesUpdatedAt, refreshRates } from "@/lib/rates";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const rates = force ? await refreshRates() : await getRates();
    return NextResponse.json({ base: "USD", rates, quoted: quotedCurrencies(), updatedAt: ratesUpdatedAt() });
  } catch (err) {
    return NextResponse.json({ error: "获取汇率失败，请稍后重试" }, { status: 502 });
  }
}
