"use client";

import type { TradeOrder } from "./types";
import { prepareMarketHistory } from "./marketHistory";
import { clientRequestId } from "./randomId";
import { platformRequest, PlatformRequestError } from "./platformRequest";
import { PRIVATE_READ_EVENTS, accountReadHeaders, privateReadEpoch, retirePrivateReadContext } from "./privateReadContext";
import { validObservedDate } from "./observedDate";

export interface SeriesClose { d: string; c: number }
export interface PortfolioBundle { closes: Record<string, SeriesClose[]>; orders: TradeOrder[]; days: number; at: number; pending?: boolean }
export interface PortfolioReadScope { ownerId?: string; signature?: string; signal?: AbortSignal; force?: boolean }
const TTL = 5 * 60 * 1000;
type Entry<T> = { value: T; at: number; epoch: number };
const bundles = new Map<string, Entry<PortfolioBundle>>();
const benchmarks = new Map<string, Entry<SeriesClose[]>>();
type Flight<T> = { kind: string; epoch: number; controller: AbortController; observers: Set<symbol>; promise: Promise<T | null>; settled: boolean };
const pending = new Map<string, Flight<unknown>>();
const active = new Set<Flight<unknown>>();
const tickets = new Map<string, symbol>();
const keyFor = (kind: string, owner: string, signature: string, query: string) => JSON.stringify([kind,owner,signature,query]);
const valid = <T,>(entry?: Entry<T>): entry is Entry<T> => Boolean(entry && entry.epoch === privateReadEpoch() && Date.now() >= entry.at && Date.now() - entry.at < TTL);

/** A caller may leave a page without cancelling another page's shared read. */
function observe<T>(flight: Flight<T>, signal?: AbortSignal): Promise<T | null> {
  const observer = Symbol(); flight.observers.add(observer);
  return new Promise((resolve,reject) => {
    const release = () => { flight.observers.delete(observer); signal?.removeEventListener("abort",stop); };
    const stop = () => { release(); reject(signal?.reason ?? new DOMException("Aborted","AbortError")); if (!flight.observers.size && !flight.settled) flight.controller.abort(); };
    flight.promise.then(resolve,reject).finally(release);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort",stop,{once:true});
  });
}
function retireFlights() {
  for (const flight of active) if (flight.epoch !== privateReadEpoch()) flight.controller.abort();
}
if (typeof window !== "undefined") for (const event of PRIVATE_READ_EVENTS) window.addEventListener(event, retireFlights);

async function readScoped<T>(kind: string, query: string, scope: PortfolioReadScope, store: Map<string, Entry<T>>, empty: T | null, load: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  if (scope.signal?.aborted) throw scope.signal.reason ?? new DOMException("Aborted","AbortError");
  const owner = scope.ownerId || "", signature = scope.signature || "";
  const cacheable = Boolean(owner && signature);
  const key = keyFor(kind,owner,signature,query), epoch = privateReadEpoch(), hit = store.get(key);
  retireFlights();
  if (!scope.force && cacheable && valid(hit)) return hit.value;
  const previous = cacheable ? pending.get(key) : undefined;
  if (!scope.force && previous && !previous.controller.signal.aborted && previous.epoch === epoch) return observe(previous as Flight<T>,scope.signal);
  if (scope.force) previous?.controller.abort();
  if ([...active].filter(value => value.kind === kind && !value.controller.signal.aborted).length >= (kind === "bundle" ? 4 : 6)) return valid(hit) ? hit.value : empty;
  const ticket = Symbol(); if (cacheable) tickets.set(key,ticket);
  const flight: Flight<T> = {kind,epoch,controller:new AbortController(),observers:new Set(),promise:Promise.resolve(empty),settled:false};
  active.add(flight);
  flight.promise = (async () => {
    try {
      const value = await load(flight.controller.signal);
      if (flight.controller.signal.aborted || privateReadEpoch() !== epoch || (cacheable && tickets.get(key) !== ticket)) return empty;
      if (cacheable && !(value as {pending?:boolean})?.pending) {
        store.delete(key); store.set(key,{value,at:Date.now(),epoch});
        while (store.size > (kind === "bundle" ? 4 : 12)) store.delete(store.keys().next().value!);
      }
      return value;
    } catch (error) {
      if (flight.controller.signal.aborted || privateReadEpoch() !== epoch || (cacheable && tickets.get(key) !== ticket)) return empty;
      if (error instanceof PlatformRequestError && [401,403].includes(error.status ?? 0)) {
        bundles.clear(); benchmarks.clear(); retirePrivateReadContext();
        retireFlights();
        throw error;
      }
      return privateReadEpoch() === epoch && (!cacheable || tickets.get(key) === ticket) && valid(hit) ? hit.value : empty;
    } finally {
      flight.settled = true; active.delete(flight);
      if (tickets.get(key) === ticket) tickets.delete(key);
      if (pending.get(key) === flight) pending.delete(key);
    }
  })();
  if (cacheable) pending.set(key,flight);
  return observe(flight,scope.signal);
}
export function peekPortfolioBundle(days = 330, scope: PortfolioReadScope = {}): PortfolioBundle | null {
  if (!scope.ownerId || !scope.signature) return null;
  const hit = bundles.get(keyFor("bundle",scope.ownerId,scope.signature,String(days)));
  return valid(hit) ? hit.value : null;
}

/** One bounded, account-bound material read; never a reconstructed historical NAV. */
export async function fetchPortfolioBundle({days = 330, ...scope}: PortfolioReadScope & {days?: number} = {}): Promise<PortfolioBundle | null> {
  return readScoped("bundle",String(days),scope,bundles,null,async signal => {
    await platformRequest("/api/v1/portfolio-series/prepare",{method:"POST",signal,headers:{"Content-Type":"application/json",...accountReadHeaders(scope.ownerId)},body:JSON.stringify({requestId:clientRequestId(),days})},20000);
    let data = await platformRequest<Partial<PortfolioBundle>>(`/api/v1/portfolio-series?${new URLSearchParams({days:String(days)})}`,{headers:accountReadHeaders(scope.ownerId),signal},20000);
    for (let retry=0;data?.pending && retry<12;retry++) {
      await new Promise<void>((resolve,reject)=>{
        const stop=()=>{clearTimeout(timer);signal.removeEventListener("abort",stop);reject(signal.reason ?? new DOMException("Aborted","AbortError"));};
        const timer=setTimeout(()=>{signal.removeEventListener("abort",stop);resolve();},2000);
        if(signal.aborted)stop();else signal.addEventListener("abort",stop,{once:true});
      });
      data=await platformRequest<Partial<PortfolioBundle>>(`/api/v1/portfolio-series?${new URLSearchParams({days:String(days)})}`,{headers:accountReadHeaders(scope.ownerId),signal},20000);
    }
    if (!data?.closes || typeof data.closes !== "object" || Array.isArray(data.closes) || !Array.isArray(data.orders)) throw Error("组合历史格式无效");
    return {closes:Object.fromEntries(Object.entries(data.closes).map(([id,rows]) => [id,normalizeCloses(rows)])),orders:data.orders,pending:data.pending === true,days:Number(data.days)||days,at:Number(data.at)||Date.now()};
  });
}

/** Preserve only observed positive closes; conflicting points do not become a curve. */
export function normalizeCloses(items: SeriesClose[] | undefined): SeriesClose[] {
  if (!Array.isArray(items)) return [];
  const values = new Map<string,number>(), conflicts = new Set<string>();
  for (const item of items) {
    if (!validObservedDate(item?.d) || !["number","string"].includes(typeof item.c) || !Number.isFinite(Number(item.c)) || Number(item.c) <= 0) continue;
    if (values.has(item.d) && values.get(item.d) !== Number(item.c)) conflicts.add(item.d);
    values.set(item.d,Number(item.c));
  }
  return [...values].filter(([d]) => !conflicts.has(d)).sort(([a],[b]) => a.localeCompare(b)).map(([d,c]) => ({d,c}));
}
export async function fetchBenchmarkKline(market: string, code: string, days = 330, index = false, scope: PortfolioReadScope = {}): Promise<SeriesClose[]> {
  const query = `${market.toUpperCase()}:${code.toUpperCase()}:${days}:${index ? 1 : 0}`;
  return await readScoped("benchmark",query,{...scope,signature:scope.signature || "benchmark"},benchmarks,[],async signal => {
    await prepareMarketHistory([{market:market.toUpperCase(),code:code.toUpperCase()}],{days,index,ownerId:scope.ownerId,signal});
    const data = await platformRequest<{items:SeriesClose[]}>(`/api/kline/full?market=${encodeURIComponent(market)}&code=${encodeURIComponent(code)}&limit=${days}&adjust=none${index ? "&index=1" : ""}`,{headers:accountReadHeaders(scope.ownerId),signal},20000);
    if (!Array.isArray(data?.items)) throw Error("基准历史格式无效");
    return normalizeCloses(data.items);
  }) ?? [];
}
