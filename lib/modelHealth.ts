import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./tradingSquareCache";

type Health = { ok: boolean; latencyMs: number; checkedAt: string; error?: string };

const health = new Map<string, Health>();
const testedHealth = new Map<string, Health & { signature: string }>();
const TEST_HEALTH_FILE = path.join(process.cwd(), "data", "model-test-health.json");
type TestedHealth = Record<string, Health & { signature: string }>;

export function setModelTestHealth(serviceId: string, model: string, signature: string, value: Health) {
  const key = `${serviceId}\0${model}`;
  testedHealth.set(key, { ...value, signature });
  try {
    const saved = readJsonFile<TestedHealth>(TEST_HEALTH_FILE, {});
    saved[key] = { ...value, signature };
    writeJsonAtomic(TEST_HEALTH_FILE, saved);
  } catch { /* read-only deployments retain status for the current process */ }
}

export function getModelTestHealth(serviceId: string, model: string, signature: string): Health | null {
  const key = `${serviceId}\0${model}`;
  const result = readJsonFile<TestedHealth>(TEST_HEALTH_FILE, {})[key] || testedHealth.get(key);
  return result?.signature === signature ? result : null;
}

export function setModelHealth(serviceId: string, model: string, value: Health) {
  health.set(`${serviceId}\0${model}`, value);
}

export function getModelHealth(serviceId: string, model: string): Health | null {
  return health.get(`${serviceId}\0${model}`) || null;
}
