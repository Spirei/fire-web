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
  const sameEndpoint = apiUrl.trim() === service.apiUrl.trim();
  return {
    ...service, name: defaults.name, apiUrl, models: [...defaults.models],
    icon: "", icons: { ...service.icons, [service.provider]: "" },
    apiKey: sameEndpoint ? service.apiKey : "",
    apiKeyConfigured: sameEndpoint && Boolean(service.apiKey || service.apiKeyConfigured),
    providerConfigs: { ...service.providerConfigs, [service.provider]: modelProviderConfig(service) }
  };
}
