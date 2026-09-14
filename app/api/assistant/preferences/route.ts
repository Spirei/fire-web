import { getAuthUser } from "@/lib/auth";
import { clearAssistantPreferences, getAssistantPreferences, saveAssistantPreferences } from "@/lib/assistantPreferences";
import { readLimitedJson, RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

function allowed(request: Request, userId: string) {
  return rateLimit(`assistant-preferences:${clientIp(request)}:${userId}`, 60, 60_000) && rateLimitGlobal("assistant-preferences", 300, 60_000);
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  return allowed(request, user.id) ? Response.json(getAssistantPreferences(user.id), { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "请求过于频繁" }, { status: 429 });
}
export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  if (!allowed(request, user.id)) return Response.json({ error: "请求过于频繁" }, { status: 429 });
  try { return Response.json(saveAssistantPreferences(user.id, await readLimitedJson(request, 4 * 1024))); }
  catch (error) { return Response.json({ error: error instanceof RequestBodyTooLargeError ? "记忆内容过大" : "保存失败" }, { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }); }
}
export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  return allowed(request, user.id) ? Response.json(clearAssistantPreferences(user.id)) : Response.json({ error: "请求过于频繁" }, { status: 429 });
}
