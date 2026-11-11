import { platformRequest, PlatformRequestError } from "./platformRequest";
import { refreshFxObservation } from "./fxRefreshCommand";

export interface FxRatesSnapshot {
  rates: Record<string, number>;
  quoted: Set<string>;
  updatedAt: number | null;
  estimatedMop: boolean;
}
export type FxRatesInitial = { data: unknown; error?: string; checkedAt?: number };

export class FxRatesError extends Error { status?: number }

/** Only quoted prices enter the converter; valuation fallback prices stay out. */
export function parseFxRatesSnapshot(data: unknown): FxRatesSnapshot {
  if (!data || typeof data !== "object") throw new FxRatesError("汇率响应暂时不可用，请重试");
  const value = data as Record<string, unknown>;
  if (value.base !== "USD" || !value.rates || typeof value.rates !== "object" || Array.isArray(value.rates) || !Array.isArray(value.quoted)) {
    throw new FxRatesError("汇率响应暂时不可用，请重试");
  }
  const source = value.rates as Record<string, unknown>;
  if (source.USD !== 1) throw new FxRatesError("汇率响应暂时不可用，请重试");
  const rates: Record<string, number> = { USD: 1 };
  const quoted = new Set(["USD"]);
  for (const code of value.quoted) {
    if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) continue;
    const raw = source[code];
    const price = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(price) || price <= 0) continue;
    rates[code] = price;
    quoted.add(code);
  }
  const mop = rates.HKD * 1.03;
  const estimatedMop = !rates.MOP && Number.isFinite(mop) && mop > 0;
  if (estimatedMop) { rates.MOP = mop; quoted.add("MOP"); }
  return {
    rates, quoted, estimatedMop,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : null
  };
}

/** A bounded same-origin read, including response-body time; no automatic upstream retry. */
async function loadFxRates(force = false, signal?: AbortSignal, timeoutMs = force ? 25_000 : 10_000): Promise<FxRatesSnapshot> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (force) await refreshFxObservation(controller.signal);
    const data=await platformRequest<unknown>("/api/rates",{credentials:"same-origin",signal:controller.signal},timeoutMs);
    if (controller.signal.aborted) throw controller.signal.reason;
    return parseFxRatesSnapshot(data);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    if (timedOut) throw new FxRatesError("汇率请求超时，请重试");
    if (error instanceof FxRatesError) throw error;
    if (error instanceof PlatformRequestError) {
      const failure=new FxRatesError(error.status===401?"登录状态已失效，请重新登录":error.status===503?"汇率服务繁忙，请稍后重试":force?"汇率刷新失败，请检查接口配置":"汇率加载失败，请重试");
      failure.status=error.status; throw failure;
    }
    throw new FxRatesError("暂时无法读取汇率，请检查网络后重试");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}


type Flight = {controller:AbortController;promise:Promise<FxRatesSnapshot>;observers:Set<symbol>;timeout:number};
let reading:Flight|undefined,refreshing:Flight|undefined;
/** Converter, settings and all valuation views share the same bounded observation. */
export function readFxRates(force=false,signal?:AbortSignal,timeoutMs=force?25000:10000):Promise<FxRatesSnapshot> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted","AbortError"));
  if(force && !refreshing){reading?.controller.abort();reading=undefined;}
  let flight=refreshing ?? (!force?reading:undefined);
  if (!flight || flight.controller.signal.aborted || (flight!==refreshing && flight.timeout!==timeoutMs)) {
    const controller=new AbortController();
    const created:Flight={controller,promise:Promise.resolve(null as unknown as FxRatesSnapshot),observers:new Set(),timeout:timeoutMs};
    created.promise=loadFxRates(force,controller.signal,timeoutMs).finally(()=>{if(reading===created)reading=undefined;if(refreshing===created)refreshing=undefined;});
    flight=created;
    if(force)refreshing=created;else reading=created;
  }
  const current=flight,observer=Symbol();current.observers.add(observer);
  return new Promise((resolve,reject)=>{
    const release=()=>{signal?.removeEventListener("abort",stop);current.observers.delete(observer);};
    const stop=()=>{release();reject(signal?.reason ?? new DOMException("Aborted","AbortError"));if(!current.observers.size)current.controller.abort();};
    signal?.addEventListener("abort",stop,{once:true});
    current.promise.then(resolve,reject).finally(release);
  });
}

if(typeof window!=="undefined")window.addEventListener("fire:settings-updated",(event)=>{if((event as CustomEvent).detail?.dataChanged===false)return;reading?.controller.abort();refreshing?.controller.abort();reading=undefined;refreshing=undefined;});
