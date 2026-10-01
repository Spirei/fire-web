import path from "node:path";
import { hmacWithDataKey } from "./secretStorage";
import { readJsonFile, writeJsonAtomic } from "./tradingSquareCache";

type Health = { ok: boolean; latencyMs: number; checkedAt: string; error?: string };

const health = new Map<string, Health & { signature?: string }>();
const testedHealth = new Map<string, Health & { signature: string }>();
const TEST_HEALTH_FILE = path.join(process.cwd(), "data", "model-test-health.json");
type TestedHealth = Record<string, Health & { signature: string }>;

export function setModelTestHealth(serviceId: string, model: string, signature: string, value: Health) {
  const key = `${serviceId}\0${model}`;
  testedHealth.set(key, { ...value, signature });
  if (testedHealth.size > 500) testedHealth.delete(testedHealth.keys().next().value!);
  try {
    const saved = readJsonFile<TestedHealth>(TEST_HEALTH_FILE, {});
    saved[key] = { ...value, signature };
    const entries = Object.entries(saved).sort((a, b) => Date.parse(b[1].checkedAt) - Date.parse(a[1].checkedAt)).slice(0, 500);
    writeJsonAtomic(TEST_HEALTH_FILE, Object.fromEntries(entries));
  } catch { /* read-only deployments retain status for the current process */ }
}

export function getModelTestHealth(serviceId: string, model: string, signature: string): Health | null {
  const key = `${serviceId}\0${model}`;
  const result = readJsonFile<TestedHealth>(TEST_HEALTH_FILE, {})[key] || testedHealth.get(key);
  return result?.signature === signature ? result : null;
}

export function setModelHealth(serviceId: string, model: string, value: Health, signature?: string) {
  health.set(`${serviceId}\0${model}`, { ...value, signature });
  if (health.size > 500) health.delete(health.keys().next().value!);
}

export function getModelHealth(serviceId: string, model: string, signature?: string): Health | null {
  const value = health.get(`${serviceId}\0${model}`);
  if (!value || (signature !== undefined && value.signature !== signature)) return null;
  return { ok: value.ok, latencyMs: value.latencyMs, checkedAt: value.checkedAt, ...(value.error ? { error: value.error } : {}) };
}

export function modelHealthSignature(provider: string, apiUrl: string, apiKey: string, model: string) {
  return hmacWithDataKey(JSON.stringify([provider, apiUrl, apiKey, model]));
}
