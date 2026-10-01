import type { ModelProviderConfig, ModelServiceConfig } from "./types";

export function modelProviderConfig(service: ModelServiceConfig): ModelProviderConfig {
  return { apiUrl: service.apiUrl, apiKey: service.apiKey, apiKeyConfigured: service.apiKeyConfigured, models: [...service.models] };
}

/** Only the active provider participates in requests; other drafts survive switching. */
export function switchModelProvider(service: ModelServiceConfig, provider: ModelServiceConfig["provider"], defaultUrl: string): ModelServiceConfig {
  if (service.provider === provider) return service;
  const providerConfigs = { ...service.providerConfigs, [service.provider]: modelProviderConfig(service) };
  const target = providerConfigs[provider] || { apiUrl: defaultUrl, apiKey: "", apiKeyConfigured: false, models: [provider === "jev" ? "jev-latest" : ""] };
  return { ...service, ...target, provider, providerConfigs, icon: service.icons?.[provider] || "" };
}

export function resetModelProvider(service: ModelServiceConfig, defaults: { name: string; apiUrl: string; models: string[] }): ModelServiceConfig {
  const apiUrl = defaults.apiUrl || service.apiUrl;
  const sameEndpoint = canonicalEndpoint(apiUrl) === canonicalEndpoint(service.apiUrl);
  return {
    ...service, name: defaults.name, apiUrl, models: [...defaults.models],
    icon: "", icons: { ...service.icons, [service.provider]: "" },
    apiKey: sameEndpoint ? service.apiKey : "",
    apiKeyConfigured: sameEndpoint && Boolean(service.apiKey || service.apiKeyConfigured),
    providerConfigs: { ...service.providerConfigs, [service.provider]: modelProviderConfig(service) }
  };
}

function canonicalEndpoint(value: string) {
  try { return new URL(value.trim()).toString(); } catch { return value.trim(); }
}

/** Editing the destination must never carry a newly typed key to another endpoint. */
export function updateModelEndpoint(service: ModelServiceConfig, apiUrl: string): ModelServiceConfig {
  const changed = canonicalEndpoint(service.apiUrl) !== canonicalEndpoint(apiUrl);
  const providerConfigs = { ...service.providerConfigs };
  if (!providerConfigs[service.provider] || canonicalEndpoint(providerConfigs[service.provider]!.apiUrl) === canonicalEndpoint(service.apiUrl)) providerConfigs[service.provider] = modelProviderConfig(service);
  const saved = providerConfigs[service.provider];
  const restored = saved && canonicalEndpoint(saved.apiUrl) === canonicalEndpoint(apiUrl);
  return { ...service, apiUrl, providerConfigs, apiKey: changed ? (restored ? saved.apiKey : "") : service.apiKey, apiKeyConfigured: restored ? Boolean(saved.apiKey || saved.apiKeyConfigured) : !changed && Boolean(service.apiKeyConfigured) };
}
