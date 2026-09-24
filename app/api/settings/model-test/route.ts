import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { validateAssistantEndpoint } from "@/lib/assistantSecurity";
import { readLimitedJson, readLimitedResponseJson, RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { getModelTestHealth, setModelHealth, setModelTestHealth } from "@/lib/modelHealth";

type TestBody = { serviceId?: string; provider?: string; apiUrl?: string; apiKey?: string; model?: string };

function signature(provider: string, apiUrl: string, apiKey: string, model: string) {
  return createHash("sha256").update(JSON.stringify([provider, apiUrl, apiKey, model])).digest("hex");
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const tests: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
  for (const service of getSiteSettings().modelServices) {
    const apiUrl = validateAssistantEndpoint(service.apiUrl);
    if (!apiUrl || !service.apiKey) continue;
    for (const model of service.models) {
      const result = getModelTestHealth(service.id, model, signature(service.provider, apiUrl, service.apiKey, model));
      if (result) tests[`${service.id}:${model}`] = { ok: result.ok, latencyMs: result.latencyMs, error: result.error };
    }
  }
  return NextResponse.json({ tests });
}

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
  const model = String(body?.model || "").trim().slice(0, 160);
  const provider = String(body?.provider || saved?.provider || "");
  const apiKey = String(body?.apiKey || (saved?.provider === provider ? saved.apiKey : "") || "").trim();
  if (provider !== "jev" && provider !== "deepseek" && provider !== "openai" && provider !== "custom") {
    return NextResponse.json({ error: "模型提供方无效" }, { status: 400 });
  }
  if (!apiUrl) return NextResponse.json({ error: "API 地址无效或不安全" }, { status: 400 });
  if (!apiKey || apiKey.length > 500) return NextResponse.json({ error: "请先配置 API 密钥" }, { status: 400 });
  if (!model) return NextResponse.json({ error: "请填写模型 ID" }, { status: 400 });

  const started = Date.now();
  const testSignature = signature(provider, apiUrl, apiKey, model);
  const record = (value: { ok: boolean; latencyMs: number; checkedAt: string; error?: string }) => {
    setModelHealth(serviceId, model, value);
    setModelTestHealth(serviceId, model, testSignature, value);
  };
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(provider === "jev"
        ? { model, state: "The quote source returned a timeout.", questions: { needs_review: { type: "noul", instructions: "Did the quote source time out?" } } }
        : { model, temperature: 0, max_tokens: 128, messages: [{ role: "user", content: "只回复 OK" }] }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]),
      redirect: "manual",
      cache: "no-store"
    });
    const data = await readLimitedResponseJson<{ choices?: Array<{ message?: { content?: string } }>; answers?: { needs_review?: { type?: string; noul?: number } } }>(response, 256 * 1024).catch(() => null);
    if (!response.ok) { record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: `HTTP ${response.status}` }); return NextResponse.json({ error: `连接失败（HTTP ${response.status}）` }, { status: 502 }); }
    const compatible = provider === "jev"
      ? data?.answers?.needs_review?.type === "noul" && typeof data.answers.needs_review.noul === "number" && data.answers.needs_review.noul >= 0 && data.answers.needs_review.noul <= 1
      : Boolean(data?.choices?.[0]?.message?.content);
    if (!compatible) { record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: "incompatible" }); return NextResponse.json({ error: "接口已响应，但格式不兼容" }, { status: 502 }); }
    const latencyMs = Date.now() - started;
    record({ ok: true, latencyMs, checkedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, latencyMs });
  } catch (error) {
    record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed" });
    return NextResponse.json({ error: error instanceof Error && error.name === "TimeoutError" ? "连接超时" : "无法连接模型服务" }, { status: 502 });
  }
}
