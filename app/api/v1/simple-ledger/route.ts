import { readJsonBody } from "@/lib/requestBody";
import { getAuthUser } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import { getSimpleLedger, normalizeSimple, setSimpleLedger } from "@/lib/simpleStore";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const owner = request.headers.get("x-simple-ledger-user");
  if (owner !== null && owner !== user.id) return fail(40902, "当前账号已切换，请刷新后重试", 409);
  try { return ok(getSimpleLedger(user.id, true)); }
  catch { return fail(50001, "账本暂时无法读取，请检查数据或稍后重试", 500); }
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const owner = request.headers.get("x-simple-ledger-user");
  if (owner !== null && owner !== user.id) return fail(40902, "当前账号已切换，请刷新后重试", 409);
  const body = await readJsonBody(request).catch(() => null);
  if (!body || typeof body !== "object") return fail(40001, "无效请求", 400);
  const next = normalizeSimple({ ...getSimpleLedger(user.id), ...body });
  setSimpleLedger(user.id, next);
  return ok(next);
}
