import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { validateAssistantEndpoint } from "@/lib/assistantSecurity";
import { readLimitedJson, RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";

type TestBody = { serviceId?: string; apiUrl?: string; apiKey?: string; model?: string };

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  if (!rateLimit(`model-test:${clientIp(request)}:${user.id}`, 12, 60_000) || !rateLimitGlobal("model-test", 60, 60_000)) {
    return NextResponse.json({ error: "测试过于频繁，请稍后再试" }, { status: 429 });
  }
  let body: TestBody | null;
  try { body = await readLimitedJson<TestBody>(request, 8 * 1024); }
  catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "请求内容过大" }, { status: 413 });
    throw error;
  }
  const serviceId = String(body?.serviceId || "").trim();
  const saved = getSiteSettings().modelServices.find(item => item.id === serviceId);
  const apiUrl = validateAssistantEndpoint(String(body?.apiUrl || saved?.apiUrl || "").trim());
  const apiKey = String(body?.apiKey || saved?.apiKey || "").trim();
  const model = String(body?.model || "").trim().slice(0, 160);
  if (!apiUrl) return NextResponse.json({ error: "API 地址无效或不安全" }, { status: 400 });
  if (!apiKey || apiKey.length > 500) return NextResponse.json({ error: "请先配置 API 密钥" }, { status: 400 });
  if (!model) return NextResponse.json({ error: "请填写模型 ID" }, { status: 400 });

  const started = Date.now();
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 8, messages: [{ role: "user", content: "只回复 OK" }] }),
      signal: AbortSignal.timeout(12_000),
      redirect: "manual",
      cache: "no-store"
    });
    const data = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
    if (!response.ok) return NextResponse.json({ error: `连接失败（HTTP ${response.status}）` }, { status: 502 });
    if (!data?.choices?.[0]?.message?.content) return NextResponse.json({ error: "接口已响应，但格式不兼容" }, { status: 502 });
    return NextResponse.json({ ok: true, latencyMs: Date.now() - started });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.name === "TimeoutError" ? "连接超时" : "无法连接模型服务" }, { status: 502 });
  }
}
