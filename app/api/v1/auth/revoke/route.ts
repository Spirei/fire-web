import { assertAppOrigin, APP_CLIENT_ID, revokeAppToken } from "@/lib/appAuth";
import { fail, ok } from "@/lib/api";
import { readJsonBody } from "@/lib/requestBody";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export async function POST(request: Request) {
  try { assertAppOrigin(request); } catch (error) { return fail(40301, (error as Error).message, 403); }
  if (!rateLimit(`app-revoke:${clientIp(request)}`, 60, 60_000)) return fail(42901, "请求过于频繁", 429);
  const body = await readJsonBody(request, 8192).catch(() => null);
  if (!body || body.client_id !== APP_CLIENT_ID || typeof body.token !== "string" || !/^(fat|frt)_[A-Za-z0-9_-]{43}$/.test(body.token)) return fail(40001, "无效的连接凭据", 400);
  revokeAppToken(body.token);
  return ok({ revoked: true });
}
