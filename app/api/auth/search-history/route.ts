import { NextResponse } from "next/server";
import { getAuthUser, isTrustedMutationRequest } from "@/lib/auth";
import { readJsonBody, RequestBodyTooLargeError } from "@/lib/requestBody";
import { parseSearchMutation } from "@/lib/searchHistory";
import { searchHistoryRuntime, SearchHistoryUnavailable } from "@/lib/searchHistoryRuntime";
import { rateLimit } from "@/lib/rateLimit";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function access(request: Request) {
  try {
    const user = request.headers.has("authorization") ? null : getAuthUser(request);
    if (!user) return json({ error: "未登录" }, 401);
    if (new URL(request.url).search) return json({ error: "参数无效" }, 400);
    if (request.method !== "GET" && !isTrustedMutationRequest(request)) return json({ error: "无效来源" }, 403);
    if (!rateLimit(`search-history:${user.id}`, 120, 60000)) return json({ error: "操作过于频繁" }, 429);
    const mutation = request.method === "GET" ? undefined : parseSearchMutation(await readJsonBody(request, 2048));
    if (mutation === null || mutation && (request.method === "POST") !== (mutation.action === "record")) return json({ error: "参数无效" }, 400);
    const authorize = () => {
      if (getAuthUser(request)?.id !== user.id) throw Object.assign(Error("登录已变化"), { status: 401 });
    };
    authorize();
    const store = await searchHistoryRuntime();
    const result = await store.access(user.id, mutation, authorize);
    return json(result, result.conflict ? 409 : 200);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json({ error: "请求过大" }, 413);
    if (error instanceof SearchHistoryUnavailable) return json({ error: error.message, available: false }, 503);
    if ((error as { status?: number }).status === 401) return json({ error: "登录已变化" }, 401);
    return json({ error: "搜索历史暂不可用，请重试" }, 503);
  }
}
export const GET = access;
export const POST = access;
export const DELETE = access;
