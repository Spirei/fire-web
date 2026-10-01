import { getAuthUser } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { configuredModelServices } from "@/lib/modelServices";
import { validateAssistantEndpoint } from "@/lib/assistantSecurity";
import { getModelHealth, modelHealthSignature } from "@/lib/modelHealth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const services = configuredModelServices(getSiteSettings()).filter(service => service.provider !== "jev").flatMap((service) =>
    service.models.map((model) => ({
      serviceId: service.id,
      serviceName: service.name,
      provider: service.provider,
      icon: service.icon,
      model,
      configured: Boolean(service.apiKey && validateAssistantEndpoint(service.apiUrl)),
      health: getModelHealth(service.id, model, modelHealthSignature(service.provider, validateAssistantEndpoint(service.apiUrl) || "", service.apiKey, model))
    }))
  ).map((service, index) => ({ ...service, priority: index + 1 }));
  return Response.json({ services }, { headers: { "Cache-Control": "no-store" } });
}
