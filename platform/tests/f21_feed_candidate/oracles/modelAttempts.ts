export function modelAttempts(settings: SiteSettings, preferred?: { serviceId?: string; model?: string }) {
  const all = configuredModelServices(settings).filter(service => service.provider !== "jev").flatMap(service => {
    const apiUrl = validateModelEndpoint(service.apiUrl);
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