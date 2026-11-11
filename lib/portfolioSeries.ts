"use client";

import type { TradeOrder } from "./types";
import { platformRequest, PlatformRequestError } from "./platformRequest";
import { accountReadHeaders, privateReadEpoch, retirePrivateReadContext } from "./privateReadContext";

export interface SeriesClose { d: string; c: number }
export interface PortfolioBundle { closes: Record<string, SeriesClose[]>; orders: TradeOrder[]; days: number; at: number }
export interface PortfolioReadScope { ownerId?: string; signature?: string; signal?: AbortSignal; force?: boolean }
const TTL = 5 * 60 * 1000;
type Entry<T> = { value: T; at: number; epoch: number };
const bundles = new Map<string, Entry<PortfolioBundle>>();
const benchmarks = new Map<string, Entry<SeriesClose[]>>();
const pending = new Map<string, Promise<unknown>>();
const tickets = new Map<string, symbol>();
const keyFor = (kind: string, owner: string, signature: string, query: string) => JSON.stringify([kind,owner,signature,query]);
const valid = <T,>(entry?: Entry<T>): entry is Entry<T> => Boolean(entry && entry.epoch === privateReadEpoch() && Date.now() >= entry.at && Date.now() - entry.at < TTL);

/** A caller may leave a page without cancelling another page's shared read. */
function observe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve,reject) => {
    const stop = () => reject(signal.reason ?? new DOMException("Aborted","AbortError"));
    promise.then(resolve,reject).finally(() => signal.removeEventListener("abort",stop));
    if (signal.aborted) stop();
    else signal.addEventListener("abort",stop,{once:true});
  });
}
async function readScoped<T>(kind: string, query: string, scope: PortfolioReadScope, store: Map<string, Entry<T>>, empty: T | null, load: () => Promise<T>): Promise<T | null> {
  if (scope.signal?.aborted) throw scope.signal.reason ?? new DOMException("Aborted","AbortError");
  const owner = scope.ownerId || "", signature = scope.signature || "";
  const cacheable = Boolean(owner && signature);
  const key = keyFor(kind,owner,signature,query), epoch = privateReadEpoch(), hit = store.get(key);
  if (!scope.force && cacheable && valid(hit)) return hit.value;
  if (!scope.force && cacheable && pending.has(key)) return observe(pending.get(key) as Promise<T | null>,scope.signal);
  const ticket = Symbol(); if (cacheable) tickets.set(key,ticket);
  let task!: Promise<T | null>;
  task = (async () => {
    try {
      const value = await load();
      if (privateReadEpoch() !== epoch || (cacheable && tickets.get(key) !== ticket)) return empty;
      if (cacheable) {
        store.delete(key); store.set(key,{value,at:Date.now(),epoch});
        while (store.size > (kind === "bundle" ? 4 : 12)) store.delete(store.keys().next().value!);
      }
      return value;
    } catch (error) {
      if (error instanceof PlatformRequestError && [401,403].includes(error.status ?? 0)) {
        bundles.clear(); benchmarks.clear(); retirePrivateReadContext();
        throw error;
      }
      return privateReadEpoch() === epoch && (!cacheable || tickets.get(key) === ticket) && valid(hit) ? hit.value : empty;
    } finally {
      if (tickets.get(key) === ticket) tickets.delete(key);
      if (pending.get(key) === task) pending.delete(key);
    }
  })();
  if (cacheable) pending.set(key,task);
  return observe(task,scope.signal);
}
export function peekPortfolioBundle(days = 330, scope: PortfolioReadScope = {}): PortfolioBundle | null {
  if (!scope.ownerId || !scope.signature) return null;
  const hit = bundles.get(keyFor("bundle",scope.ownerId,scope.signature,String(days)));
  return valid(hit) ? hit.value : null;
}

/** One bounded, account-bound material read; never a reconstructed historical NAV. */
export async function fetchPortfolioBundle({days = 330, ...scope}: PortfolioReadScope & {days?: number} = {}): Promise<PortfolioBundle | null> {
  return readScoped("bundle",String(days),scope,bundles,null,async () => {
    const data = await platformRequest<Partial<PortfolioBundle>>(`/api/v1/portfolio-series?${new URLSearchParams({days:String(days)})}`,{headers:accountReadHeaders(scope.ownerId)},20000);
    if (!data?.closes || typeof data.closes !== "object" || Array.isArray(data.closes) || !Array.isArray(data.orders)) throw Error("组合历史格式无效");
    return {closes:Object.fromEntries(Object.entries(data.closes).map(([id,rows]) => [id,normalizeCloses(rows)])),orders:data.orders,days:Number(data.days)||days,at:Number(data.at)||Date.now()};
  });
}

/** Preserve only observed positive closes; conflicting points do not become a curve. */
export function normalizeCloses(items: SeriesClose[] | undefined): SeriesClose[] {
  if (!Array.isArray(items)) return [];
  const values = new Map<string,number>(), conflicts = new Set<string>();
  for (const item of items) {
    if (typeof item?.d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.d) || item.c == null || !Number.isFinite(Number(item.c)) || Number(item.c) <= 0) continue;
    if (values.has(item.d) && values.get(item.d) !== Number(item.c)) conflicts.add(item.d);
    values.set(item.d,Number(item.c));
  }
  return [...values].filter(([d]) => !conflicts.has(d)).sort(([a],[b]) => a.localeCompare(b)).map(([d,c]) => ({d,c}));
}
export async function fetchBenchmarkKline(market: string, code: string, days = 330, index = false, scope: PortfolioReadScope = {}): Promise<SeriesClose[]> {
  const query = `${market.toUpperCase()}:${code.toUpperCase()}:${days}:${index ? 1 : 0}`;
  return await readScoped("benchmark",query,{...scope,signature:scope.signature || "benchmark"},benchmarks,[],async () => {
    const data = await platformRequest<{items:SeriesClose[]}>(`/api/kline/full?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}&limit=${days}${index ? "&index=1" : ""}`,{headers:accountReadHeaders(scope.ownerId)},20000);
    if (!Array.isArray(data?.items)) throw Error("基准历史格式无效");
    return normalizeCloses(data.items);
  }) ?? [];
}
