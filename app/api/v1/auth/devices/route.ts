import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { listAppDevices, revokeAppGrant } from "@/lib/appAuth";
import { fail, ok } from "@/lib/api";
import { readJsonBody } from "@/lib/requestBody";
import { rateLimit } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export async function GET(request: Request) {
  const user = !request.headers.has("authorization") && getAuthUser(request);
  return user ? ok({ devices: listAppDevices(user.id) }) : fail(40101, "请在 Alcor 网页登录", 401);
}
export async function DELETE(request: Request) {
  if (!request.headers.get("origin") || !isTrustedMutationRequest(request)) return fail(40301, "请求来源不受信任", 403);
  const user = !request.headers.has("authorization") && getAuthUser(request);
  if (!user) return fail(40101, "请在 Alcor 网页登录", 401);
  if (!rateLimit(`app-device:${user.id}`, 30, 60_000)) return fail(42901, "请求过于频繁", 429);
  const body = await readJsonBody(request, 8192).catch(() => null);
  if (!body || typeof body.id !== "string") return fail(40001, "缺少设备 ID", 400);
  revokeAppGrant(body.id, user.id);
  logSecurityEvent(request, user.id, "app.revoked", "已断开 App 设备");
  return ok({ revoked: true });
}
