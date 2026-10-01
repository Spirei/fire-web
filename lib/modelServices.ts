import type { ModelServiceConfig, SiteSettings } from "./types";
import { validateAssistantEndpoint } from "./assistantSecurity";
import { modelProviderConfig } from "./modelServiceDrafts";

const PROVIDERS = new Set(["deepseek", "openai", "jev", "custom"]);

function normalizeProviderConfig(item: Record<string, unknown>) {
  return {
    apiUrl: String(item.apiUrl || "").trim().slice(0, 2048),
    apiKey: String(item.apiKey || "").trim().slice(0, 500),
    models: Array.isArray(item.models)
      ? [...new Set(item.models.map(model => String(model).trim()).filter(Boolean))].slice(0, 20).map(model => model.slice(0, 160)) : []
  };
}

/** A stored secret belongs to one service, provider and endpoint. */
export function savedModelProviderConfig(service: ModelServiceConfig | undefined, provider: string, apiUrl: string) {
  if (!service || !PROVIDERS.has(provider)) return undefined;
  const config = service.provider === provider ? modelProviderConfig(service) : service.providerConfigs?.[provider as ModelServiceConfig["provider"]];
  const endpoint = validateAssistantEndpoint(apiUrl);
  return config && endpoint && validateAssistantEndpoint(config.apiUrl) === endpoint ? config : undefined;
}

export function normalizeModelServices(value: unknown): ModelServiceConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 12).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const provider = PROVIDERS.has(String(item.provider)) ? String(item.provider) as ModelServiceConfig["provider"] : "custom";
    const icons: NonNullable<ModelServiceConfig["icons"]> = {};
    if (item.icons && typeof item.icons === "object" && !Array.isArray(item.icons)) {
      for (const [key, value] of Object.entries(item.icons)) {
        if (PROVIDERS.has(key) && typeof value === "string" && value.trim()) icons[key as ModelServiceConfig["provider"]] = value.trim().slice(0, 500);
      }
    }
    // 旧版单图标没有来源标记；仅自定义服务可安全继承，避免品牌间串图。
    if (provider === "custom" && !icons.custom && typeof item.icon === "string") icons.custom = item.icon.trim().slice(0, 500);
    const fallbackId = `model-service-${index + 1}`;
    let id = String(item.id || fallbackId).trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || fallbackId;
    let suffix = 1;
    while (seen.has(id)) id = `${fallbackId}-${suffix++}`;
    seen.add(id);
    const providerConfigs: NonNullable<ModelServiceConfig["providerConfigs"]> = {};
    if (item.providerConfigs && typeof item.providerConfigs === "object" && !Array.isArray(item.providerConfigs)) {
      for (const [key, config] of Object.entries(item.providerConfigs)) {
        if (PROVIDERS.has(key) && config && typeof config === "object" && !Array.isArray(config)) {
          providerConfigs[key as ModelServiceConfig["provider"]] = normalizeProviderConfig(config as Record<string, unknown>);
        }
      }
    }
    return [{
      id,
      name: String(item.name || (provider === "deepseek" ? "DeepSeek" : provider === "openai" ? "OpenAI" : provider === "jev" ? "Jev" : "自定义服务")).trim().slice(0, 50),
      provider,
      icon: icons[provider] || "",
      icons,
      ...normalizeProviderConfig(item),
      providerConfigs
    }];
  });
}

function validateProviderConfig(raw: Record<string, unknown>, name: string) {
  if (typeof raw.apiUrl !== "string" || raw.apiUrl.length > 2048 || (raw.apiUrl.trim() && !validateAssistantEndpoint(raw.apiUrl.trim()))) throw new Error(`${name} 的 API 地址无效或不安全`);
  if (typeof raw.apiKey !== "string" || raw.apiKey.trim().length > 500 || /[\r\n\0]/.test(raw.apiKey) || raw.apiKey.startsWith("enc:")) throw new Error(`${name} 的 API 密钥格式无效`);
  if (!Array.isArray(raw.models) || raw.models.length > 20 || raw.models.some(model => typeof model !== "string" || model.trim().length > 160 || /[\r\n\0]/.test(model))) throw new Error(`${name} 的模型 ID 格式无效，最多配置 20 个模型`);
  const models = raw.models.map(model => (model as string).trim()).filter(Boolean);
  if (new Set(models).size !== models.length) throw new Error(`${name} 的模型 ID 不能重复`);
}

function validModelIcon(icon: unknown) {
  if (typeof icon !== "string") return false;
  if (!icon) return true;
  if (!/^\/uploads\/(?:asset\/icon|logo)\/[^/\\?#]+$/.test(icon)) return false;
  try { const name = decodeURIComponent(icon.split("/").at(-1)!); return name !== "." && name !== ".." && !/[\/\\\0]/.test(name); } catch { return false; }
}

/** Validate before normalization: invalid IDs and oversized keys must never be silently rewritten. */
function validateModelServiceInput(value: unknown): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error("模型服务格式无效，最多配置 12 个服务");
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !PROVIDERS.has(raw.provider)) throw new Error("模型服务提供方无效");
    if (typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id) || ids.has(raw.id)) throw new Error("模型服务 ID 无效或重复，请重新添加服务");
    ids.add(raw.id);
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 50) throw new Error("模型服务名称须为 1-50 个字符");
    validateProviderConfig(raw, raw.name);
    if (!validModelIcon(raw.icon ?? "")) throw new Error(`${raw.name} 的图标路径无效`);
    for (const field of ["providerConfigs", "icons"]) {
      const entries = raw[field];
      if (entries === undefined) continue;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("模型服务格式无效");
      for (const [provider, config] of Object.entries(entries)) {
        if (!PROVIDERS.has(provider)) throw new Error("模型服务提供方无效");
        if (field === "icons") { if (!validModelIcon(config)) throw new Error(`${raw.name} 的图标路径无效`); }
        else {
          if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("模型服务格式无效");
          validateProviderConfig(config as Record<string, unknown>, raw.name);
        }
      }
    }
  }
}

/** 与设置接口共用同一套校验和密钥继承规则，避免图标上传绕过配置检查。 */
export function prepareModelServices(value: unknown, previous: SiteSettings): ModelServiceConfig[] {
  if (previous.modelServicesError) throw new Error(previous.modelServicesError);
  validateModelServiceInput(value);
  const incoming = normalizeModelServices(value);
  if (incoming.length !== value.length) throw new Error("模型服务格式无效");
  const saved = new Map(previous.modelServices.map(item => [item.id, item]));
  return incoming.map(item => {
    const old = saved.get(item.id) || (item.id === "legacy-primary" && !previous.modelServices.length ? configuredModelServices(previous)[0] : undefined);
    const providerConfigs = { ...old?.providerConfigs, ...(old ? { [old.provider]: modelProviderConfig(old) } : {}) };
    const protectExistingEndpoint = (provider: string, apiUrl: string, apiKey: string) => {
      const existing = old?.provider === provider ? old : old?.providerConfigs?.[provider as ModelServiceConfig["provider"]];
      if (existing?.apiKey && !apiKey && validateAssistantEndpoint(existing.apiUrl) !== validateAssistantEndpoint(apiUrl)) throw new Error(`${item.name} 的 API 地址已更改，请输入新地址的密钥；原配置未修改`);
    };
    protectExistingEndpoint(item.provider, item.apiUrl, item.apiKey);
    for (const [provider, config] of Object.entries(item.providerConfigs || {})) {
      if (!config) continue;
      protectExistingEndpoint(provider, config.apiUrl, config.apiKey);
      if (config.apiUrl && !validateAssistantEndpoint(config.apiUrl)) throw new Error(`${item.name} 的 API 地址无效或不安全`);
      providerConfigs[provider as ModelServiceConfig["provider"]] = { ...config, apiKey: config.apiKey || savedModelProviderConfig(old, provider, config.apiUrl)?.apiKey || "" };
    }
    const service = {
      ...item,
      providerConfigs,
      apiKey: item.apiKey || savedModelProviderConfig(old, item.provider, item.apiUrl)?.apiKey || ""
    };
    service.providerConfigs[service.provider] = modelProviderConfig(service);
    if (!service.name) throw new Error("每个模型服务都需要名称");
    if (!validateAssistantEndpoint(service.apiUrl)) throw new Error(`${service.name} 的 API 地址无效或不安全`);
    if (service.icon && !/^\/uploads\/(?:asset\/icon|logo)\//.test(service.icon)) throw new Error(`${service.name} 的图标路径无效`);
    if (Object.values(service.icons || {}).some(icon => icon && !/^\/uploads\/(?:asset\/icon|logo)\//.test(icon))) throw new Error(`${service.name} 的图标路径无效`);
    return service;
  });
}

export function configuredModelServices(settings: SiteSettings): ModelServiceConfig[] {
  if (settings.modelServicesError) return [];
  const services = normalizeModelServices(settings.modelServices);
  if (services.length || settings.modelServicesInitialized) return services;
  const provider = settings.llmProvider === "openai" ? "openai" : settings.llmProvider === "custom" ? "custom" : "deepseek";
  const apiUrl = settings.llmApiUrl || settings.deepseekApiUrl;
  const dedicatedDeepSeek = provider === "deepseek" && validateAssistantEndpoint(apiUrl) === validateAssistantEndpoint(settings.deepseekApiUrl);
  const key = (settings.llmApiKey || (dedicatedDeepSeek ? settings.deepseekApiKey : "") || process.env.LLM_API_KEY || (dedicatedDeepSeek ? process.env.DEEPSEEK_API_KEY : "") || "").trim();
  return [{
    id: "legacy-primary",
    name: provider === "openai" ? "OpenAI" : provider === "custom" ? "自定义服务" : "DeepSeek",
    provider,
    icon: "",
    apiUrl,
    apiKey: key,
    models: [settings.llmModel || settings.deepseekModel || "deepseek-chat"]
  }];
}

export function modelAttempts(settings: SiteSettings, preferred?: { serviceId?: string; model?: string }) {
  const all = configuredModelServices(settings).filter(service => service.provider !== "jev").flatMap(service => {
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
