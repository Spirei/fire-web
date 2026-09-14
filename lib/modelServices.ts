import type { ModelServiceConfig, SiteSettings } from "./types";
import { validateAssistantEndpoint } from "./assistantSecurity";

const PROVIDERS = new Set(["deepseek", "openai", "custom"]);

export function normalizeModelServices(value: unknown): ModelServiceConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 12).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const provider = PROVIDERS.has(String(item.provider)) ? String(item.provider) as ModelServiceConfig["provider"] : "custom";
    const fallbackId = `model-service-${index + 1}`;
    let id = String(item.id || fallbackId).trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || fallbackId;
    while (seen.has(id)) id = `${fallbackId}-${seen.size + 1}`;
    seen.add(id);
    const models = Array.isArray(item.models)
      ? [...new Set(item.models.map(model => String(model).trim()).filter(Boolean))].slice(0, 20).map(model => model.slice(0, 160))
      : [];
    return [{
      id,
      name: String(item.name || (provider === "deepseek" ? "DeepSeek" : provider === "openai" ? "OpenAI" : "自定义服务")).trim().slice(0, 50),
      provider,
      icon: String(item.icon || "").trim().slice(0, 500),
      apiUrl: String(item.apiUrl || "").trim().slice(0, 2048),
      apiKey: String(item.apiKey || "").trim().slice(0, 500),
      models
    }];
  });
}

export function configuredModelServices(settings: SiteSettings): ModelServiceConfig[] {
  const services = normalizeModelServices(settings.modelServices);
  if (services.length) return services;
  const key = (settings.llmApiKey || settings.deepseekApiKey || process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "").trim();
  return [{
    id: "legacy-primary",
    name: settings.llmProvider === "openai" ? "OpenAI" : "DeepSeek",
    provider: settings.llmProvider === "openai" ? "openai" : "deepseek",
    icon: "",
    apiUrl: settings.llmApiUrl || settings.deepseekApiUrl,
    apiKey: key,
    models: [settings.llmModel || settings.deepseekModel || "deepseek-chat"]
  }];
}

export function modelAttempts(settings: SiteSettings, preferred?: { serviceId?: string; model?: string }) {
  const all = configuredModelServices(settings).flatMap(service => {
    const apiUrl = validateAssistantEndpoint(service.apiUrl);
    if (!apiUrl || !service.apiKey) return [];
    return service.models.map(model => ({ service, apiUrl, model }));
  });
  const serviceId = String(preferred?.serviceId || "").trim();
  const model = String(preferred?.model || "").trim();
  if (!serviceId && !model) return all;
  const selected = all.filter(item => (!serviceId || item.service.id === serviceId) && (!model || item.model === model));
  if (!selected.length) return all;
  const selectedKeys = new Set(selected.map(item => `${item.service.id}\0${item.model}`));
  return [...selected, ...all.filter(item => !selectedKeys.has(`${item.service.id}\0${item.model}`))];
}
