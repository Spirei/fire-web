import type { PublicQuoteDemand } from "./quoteDemand";
import { QUOTE_DEMAND_IDLE_MS, QUOTE_DEMAND_MARKETS } from "./quoteDemand";

export type PoolState = "hot" | "dormant" | "candidate";
export type PoolScope = "mine" | "shared";
export interface PoolEntry {
  market: string; code: string; lastRequestedAt: number; expiresAt: number;
  state: PoolState; updating: boolean; name?: string; icon?: string;
}
export interface PoolSnapshot { scope: PoolScope; at: number; entries: PoolEntry[] }
export interface PoolBootstrap { mine: PoolSnapshot; shared?: PoolSnapshot }
export const poolKey = (entry: Pick<PoolEntry, "market" | "code">) => `${entry.market}:${entry.code}`;
export const POOL_LABELS: Record<string, string> = { US: "美股", HK: "港股", CN: "A 股", JP: "日股", KR: "韩股", ASSET: "其他资产" };
export const POOL_STATES: Record<PoolState, string> = { hot: "活跃", dormant: "休眠", candidate: "待入池" };

/** A private view can only contain its owner's securities, even when others are hot. */
export function poolView(demands: PublicQuoteDemand[], runtime: PoolEntry[], scope: PoolScope, at: number): PoolSnapshot {
  const live = new Map(runtime.filter(row => row.expiresAt > at).map(row => [poolKey(row), row]));
  const result = new Map<string, PoolEntry>();
  for (const demand of demands) {
    if (demand.requestedAt === undefined || demand.requestedAt + QUOTE_DEMAND_IDLE_MS <= at) continue;
    const key = poolKey(demand.item), current = live.get(key);
    result.set(key, { market: demand.item.market, code: demand.item.code,
      lastRequestedAt: scope === "shared" ? Math.max(demand.requestedAt, current?.lastRequestedAt ?? 0) : demand.requestedAt,
      expiresAt: demand.requestedAt + QUOTE_DEMAND_IDLE_MS,
      state: current?.state ?? ((demand.reads ?? 1) >= 2 ? "dormant" : "candidate"), updating: current?.updating ?? false });
  }
  if (scope === "shared") for (const row of live.values()) {
    const existing = result.get(poolKey(row));
    result.set(poolKey(row), { ...row, expiresAt: Math.max(existing?.expiresAt ?? 0, row.expiresAt) });
  }
  return { scope, at, entries: [...result.values()].sort((a, b) => b.lastRequestedAt - a.lastRequestedAt || poolKey(a).localeCompare(poolKey(b))) };
}

export function poolQuery(params: Pick<URLSearchParams, "get">, admin: boolean) {
  const market = params.get("m") ?? "ALL", state = params.get("s") ?? "all";
  return { scope: (admin && params.get("scope") !== "mine" ? "shared" : "mine") as PoolScope,
    market: QUOTE_DEMAND_MARKETS.includes(market as typeof QUOTE_DEMAND_MARKETS[number]) ? market : "ALL",
    state: Object.hasOwn(POOL_STATES, state) ? state as PoolState : "all" as const,
    query: (params.get("q") ?? "").slice(0, 80), page: Math.max(1, Math.min(1000, Math.floor(Number(params.get("p")) || 1))) };
}

/** Stable slots prevent a routine snapshot update from shuffling the whole box. */
export function tokenPose(key: string, index: number) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const n = hash >>> 0;
  return { x: 24 + ([2, 3, 1, 4, 0, 5][index % 6]) * 10.5 + (n % 5 - 2) * .5,
    y: 44 + ([1, 0, 2][Math.floor(index / 6)]) * 13 + ((n >>> 4) % 5 - 2) * .4,
    mobileX: 25 + ([1, 2, 0, 3][index % 4]) * 16.5, mobileY: 43 + ([1, 0, 2][Math.floor(index / 4) % 3]) * 12.8,
    rotation: (n % 15) - 7, delay: Math.min(index, 12) * 65 };
}
