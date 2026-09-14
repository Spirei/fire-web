import { getAuthUser } from "@/lib/auth";
import { clearAssistantHistory, getAssistantHistoryState, saveAssistantHistory } from "@/lib/assistantHistory";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

function allowed(request: Request, userId: string) {
  return rateLimit(`assistant-history:${clientIp(request)}:${userId}`, 120, 60_000)
    && rateLimitGlobal("assistant-history", 600, 60_000);
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  if (!allowed(request, user.id)) return Response.json({ error: "请求过于频繁" }, { status: 429 });
  return Response.json(getAssistantHistoryState(user.id));
}

export async function PUT(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  if (!allowed(request, user.id)) return Response.json({ error: "请求过于频繁" }, { status: 429 });
  const body = await request.json().catch(() => null);
  try {
    return Response.json(saveAssistantHistory(user.id, body?.conversationId, body?.messages));
  } catch {
    return Response.json({ error: "会话标识无效" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  if (!allowed(request, user.id)) return Response.json({ error: "请求过于频繁" }, { status: 429 });
  const conversationId = new URL(request.url).searchParams.get("id");
  try {
    return Response.json(clearAssistantHistory(user.id, conversationId || undefined));
  } catch {
    return Response.json({ error: "会话标识无效" }, { status: 400 });
  }
}
