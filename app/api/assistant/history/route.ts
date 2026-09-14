import { getAuthUser } from "@/lib/auth";
import { clearAssistantHistory, getAssistantHistoryState, saveAssistantHistory, updateAssistantConversation } from "@/lib/assistantHistory";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { readLimitedJson, RequestBodyTooLargeError } from "@/lib/requestBody";

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
  let body: { conversationId?: unknown; messages?: unknown } | null;
  try {
    body = await readLimitedJson(request, 96 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "请求内容过大" }, { status: 413 });
    throw error;
  }
  if (!body) return Response.json({ error: "无效的请求体" }, { status: 400 });
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

export async function PATCH(request:Request){
  const user=getAuthUser(request); if(!user)return Response.json({error:"未登录"},{status:401});
  if(!allowed(request,user.id))return Response.json({error:"请求过于频繁"},{status:429});
  try{const body=await readLimitedJson<{conversationId?:unknown;title?:unknown;archived?:unknown}>(request,4096);return Response.json(updateAssistantConversation(user.id,body?.conversationId,{title:body?.title,archived:body?.archived}));}
  catch{return Response.json({error:"会话更新失败"},{status:400});}
}
