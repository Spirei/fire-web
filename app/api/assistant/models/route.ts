import { getAuthUser } from "@/lib/auth";
import { getSiteSettings } from "@/lib/settings";
import { configuredModelServices } from "@/lib/modelServices";
import { getModelHealth } from "@/lib/modelHealth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const services = configuredModelServices(getSiteSettings()).flatMap((service, serviceIndex) =>
    service.models.map((model, modelIndex) => ({
      serviceId: service.id,
      serviceName: service.name,
      provider: service.provider,
      icon: service.icon,
      model,
      priority: serviceIndex + modelIndex + 1,
      configured: Boolean(service.apiKey && service.apiUrl),
      health: getModelHealth(service.id, model)
    }))
  );
  return Response.json({ services }, { headers: { "Cache-Control": "no-store" } });
}
