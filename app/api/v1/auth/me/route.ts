import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";

/** v1 当前用户信息（Cookie 或 Bearer token 均可） */
export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  return ok(user);
}
