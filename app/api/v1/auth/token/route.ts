import { assertAppOrigin, exchangeAppCode, refreshAppTokens } from "@/lib/appAuth";
import { fail, ok } from "@/lib/api";
import { readJsonBody, readTextBody } from "@/lib/requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

export async function POST(request: Request) {
  try { assertAppOrigin(request); } catch (error) { return fail(40301, (error as Error).message, 403); }
  if (!rateLimit(`app-token:${clientIp(request)}`, 120, 60_000) || !rateLimitGlobal("app-token", 600, 60_000)) return fail(42901, "连接过于频繁，请稍后再试", 429);
  const body = await (request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
    ? readTextBody(request, 8192).then(text => Object.fromEntries(new URLSearchParams(text)))
    : readJsonBody(request, 8192)).catch(() => null);
  if (!body || !["authorization_code", "refresh_token"].includes(body.grant_type)) return fail(40002, "无效的令牌请求", 400);
  const tokens = body.grant_type === "authorization_code" ? exchangeAppCode(body) : refreshAppTokens(body.client_id, body.refresh_token);
  return tokens ? ok(tokens) : fail(40102, "连接已失效，请重新连接 Fire 账户", 401);
}
