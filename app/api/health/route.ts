import { ok } from "@/lib/api";
import { CURRENT_VERSION } from "@/lib/versions";
import { getFutuStatus } from "@/lib/futuQuotes";
import { getSiteSettings } from "@/lib/settings";
import { getTickerCrossCheck } from "@/lib/ticker";

export const dynamic = "force-dynamic";

/** 健康检查（移动端启动探测 / 负载均衡 / 监控） */
export async function GET() {
  const futu = await getFutuStatus();
  const configured = getSiteSettings().quoteSource || "auto";
  const effectiveSource =
    configured === "futu" ? (futu.available ? "futu" : "none")
    : configured === "tencent" ? "tencent-fallback"
    : futu.available ? "futu" : "tencent-fallback";
  return ok({
    status: "ok",
    service: "fire",
    time: new Date().toISOString(),
    version: CURRENT_VERSION.version,
    buildSha: process.env.FIRE_BUILD_SHA?.trim() || "unknown",
    quoteSource: configured,
    effectiveSource,
    futuOpenD: futu,
    /** 指数栏与富途的收盘对账结果（每个交易日一次，只覆盖富途 OpenAPI 支持的指数） */
    tickerCrossCheck: getTickerCrossCheck()
  });
}
