import { getAuthUser, isAdmin } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { parseRequestFilters } from "@/lib/apiRequestTypes";
import { readRequestSnapshot } from "@/lib/apiRequestLog";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  if (!isAdmin(user)) return fail(40301, "需要管理员权限", 403);
  try { return ok(readRequestSnapshot(parseRequestFilters(new URL(request.url).searchParams))); }
  catch { return fail(50001, "请求日志读取失败", 500); }
}
