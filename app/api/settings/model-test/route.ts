import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { configuredModelServices, savedModelProviderConfig } from "@/lib/modelServices";
import { validateAssistantEndpoint } from "@/lib/assistantSecurity";
import { readLimitedJson, readLimitedResponseJson, RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { getModelTestHealth, modelHealthSignature, setModelHealth, setModelTestHealth } from "@/lib/modelHealth";
import { proxyFetch } from "@/lib/net";

type TestBody = { serviceId?: string; provider?: string; apiUrl?: string; apiKey?: string; model?: string };

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const tests: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
  for (const service of configuredModelServices(getSiteSettings())) {
    const apiUrl = validateAssistantEndpoint(service.apiUrl);
    if (!apiUrl || !service.apiKey) continue;
    for (const model of service.models) {
      const result = getModelTestHealth(service.id, model, modelHealthSignature(service.provider, apiUrl, service.apiKey, model));
      if (result) tests[`${service.id}:${model}`] = { ok: result.ok, latencyMs: result.latencyMs, error: result.error };
    }
  }
  return NextResponse.json({ tests }, { headers: { "Cache-Control": "no-store" } });
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
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.values(body).some(value => typeof value !== "string")) return NextResponse.json({ error: "测试请求格式无效" }, { status: 400 });
  const serviceId = String(body.serviceId || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(serviceId)) return NextResponse.json({ error: "模型服务 ID 无效" }, { status: 400 });
  const saved = configuredModelServices(getSiteSettings()).find(item => item.id === serviceId);
  const provider = String(body?.provider || saved?.provider || "");
  const providerConfig = saved?.provider === provider ? saved : saved?.providerConfigs?.[provider as NonNullable<typeof saved>["provider"]];
  const apiUrl = validateAssistantEndpoint(String(body?.apiUrl ?? providerConfig?.apiUrl ?? "").trim());
  const model = String(body?.model || "").trim();
  const apiKey = String(body?.apiKey || (apiUrl ? savedModelProviderConfig(saved, provider, apiUrl)?.apiKey : "") || "").trim();
  if (provider !== "jev" && provider !== "deepseek" && provider !== "openai" && provider !== "custom") {
    return NextResponse.json({ error: "模型提供方无效" }, { status: 400 });
  }
  if (!apiUrl) return NextResponse.json({ error: "API 地址无效或不安全" }, { status: 400 });
  if (!apiKey || apiKey.length > 500 || /[\r\n\0]/.test(apiKey) || apiKey.startsWith("enc:")) return NextResponse.json({ error: "请先配置 API 密钥" }, { status: 400 });
  if (model.length > 160 || /[\r\n\0]/.test(model)) return NextResponse.json({ error: "模型 ID 格式无效" }, { status: 400 });
  if (!model) return NextResponse.json({ error: "请填写模型 ID" }, { status: 400 });

  const started = Date.now();
  const testSignature = modelHealthSignature(provider, apiUrl, apiKey, model);
  const record = (value: { ok: boolean; latencyMs: number; checkedAt: string; error?: string }) => {
    if (request.signal.aborted) return;
    // Unsaved drafts and results arriving after a configuration change cannot alter live health.
    const current = configuredModelServices(getSiteSettings()).find(item => item.id === serviceId);
    const currentUrl = current && validateAssistantEndpoint(current.apiUrl);
    if (!current || !currentUrl || !current.models.includes(model) || modelHealthSignature(current.provider, currentUrl, current.apiKey, model) !== testSignature) return;
    setModelHealth(serviceId, model, value, testSignature);
    setModelTestHealth(serviceId, model, testSignature, value);
  };
  try {
    const response = await proxyFetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(provider === "jev"
        ? { model, state: "The quote source returned a timeout.", questions: { needs_review: { type: "noul", instructions: "Did the quote source time out?" } } }
        : { model, temperature: 0, max_tokens: 512, stream: false, ...(provider === "deepseek" ? { thinking: { type: "disabled" } } : {}), messages: [{ role: "user", content: "只回复 OK" }] }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      redirect: "manual",
      cache: "no-store"
    });
    if (!response.ok) { record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: `HTTP ${response.status}` }); return NextResponse.json({ error: `连接失败（HTTP ${response.status}）` }, { status: 502 }); }
    const data = await readLimitedResponseJson<{ choices?: Array<{ finish_reason?: string; message?: { content?: unknown; reasoning_content?: unknown } }>; answers?: { needs_review?: { type?: string; noul?: number } } }>(response, 256 * 1024);
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    const content = choice?.message?.content;
    const compatible = provider === "jev"
      ? data?.answers?.needs_review?.type === "noul" && typeof data.answers.needs_review.noul === "number" && data.answers.needs_review.noul >= 0 && data.answers.needs_review.noul <= 1
      : typeof content === "string" && Boolean(content.trim());
    if (!compatible && provider !== "jev" && choice?.finish_reason === "length") {
      record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: "output_limit" });
      return NextResponse.json({ error: "接口已连接，但模型在输出答案前达到 token 上限，请调整模型或重试" }, { status: 502 });
    }
    if (!compatible) { record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: "incompatible" }); return NextResponse.json({ error: "接口已响应，但格式不兼容" }, { status: 502 }); }
    const latencyMs = Date.now() - started;
    record({ ok: true, latencyMs, checkedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, latencyMs });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: "response_too_large" });
      return NextResponse.json({ error: "模型响应内容过大" }, { status: 502 });
    }
    record({ ok: false, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed" });
    return NextResponse.json({ error: error instanceof Error && error.name === "TimeoutError" ? "连接超时" : "无法连接模型服务" }, { status: 502 });
  }
}
