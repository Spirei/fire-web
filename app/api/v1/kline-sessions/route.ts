import { GET as getSessionKline } from "@/app/api/kline/session-day/route";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** v1 美股当日分时与扩展时段（美东时间） */
export async function GET(request: Request) {
  const response = await getSessionKline(request);
  const body = await response.json().catch(() => null);
  if (response.ok) return ok(body);
  if (response.status === 400) return fail(40001, body?.error || "参数不合法", 400);
  if (response.status === 429) return fail(42901, body?.error || "请求过于频繁", 429);
  return fail(50002, body?.error || "扩展时段行情获取失败", 502);
}
