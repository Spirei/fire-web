import { parseAssetLookup } from "@/lib/assetLookup";
import { getAssetMatches } from "@/lib/assets";
import { fail, ok } from "@/lib/api";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

/** 只读公开图标索引；最多 50 个精确键，目录管理仍使用分页接口。 */
export async function GET(request: Request) {
  if (!rateLimit(`asset-lookup:${clientIp(request)}`, 120, 60_000) || !rateLimitGlobal("asset-lookup", 1200, 60_000)) return fail(42901, "请求过于频繁", 429);
  const keys = parseAssetLookup(new URL(request.url).searchParams.get("keys"));
  if (!keys) return fail(40001, "素材查询参数无效，单次最多 50 项", 400);
  return ok(getAssetMatches(keys));
}
