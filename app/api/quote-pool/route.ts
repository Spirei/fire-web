import { getAuthUser, isAdmin } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { rateLimit } from "@/lib/rateLimit";
import { readQuotePool } from "@/lib/quotePoolData";

export const dynamic = "force-dynamic";
export function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "请先登录", 401);
  const params = new URL(request.url).searchParams, scope = params.get("scope") ?? "mine";
  if ([...params.keys()].some(key => key !== "scope") || params.getAll("scope").length > 1 || !["mine", "shared"].includes(scope)) return fail(40001, "查询参数无效", 400);
  if (scope === "shared" && !isAdmin(user)) return fail(40301, "没有访问权限", 403);
  if (!rateLimit(`quote-pool:${user.id}`, 60, 60_000)) return fail(42901, "请求过于频繁", 429);
  return ok(readQuotePool(user.id, scope as "mine" | "shared"));
}
