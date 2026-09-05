import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { getSimpleLedger, normalizeSimple, setSimpleLedger } from "@/lib/simpleStore";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  return ok(getSimpleLedger(user.id));
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return fail(40001, "无效请求", 400);
  const next = normalizeSimple({ ...getSimpleLedger(user.id), ...body });
  setSimpleLedger(user.id, next);
  return ok(next);
}
