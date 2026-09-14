type Health = { ok: boolean; latencyMs: number; checkedAt: string; error?: string };

const health = new Map<string, Health>();

export function setModelHealth(serviceId: string, model: string, value: Health) {
  health.set(`${serviceId}\0${model}`, value);
}

export function getModelHealth(serviceId: string, model: string): Health | null {
  return health.get(`${serviceId}\0${model}`) || null;
}
