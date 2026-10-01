export interface FxRatesSnapshot {
  rates: Record<string, number>;
  quoted: Set<string>;
  updatedAt: number | null;
  estimatedMop: boolean;
}

export class FxRatesError extends Error {}

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
export async function readFxRates(force = false, signal?: AbortSignal, timeoutMs = force ? 25_000 : 10_000): Promise<FxRatesSnapshot> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetch(force ? "/api/rates?refresh=1" : "/api/rates", {
      credentials: "same-origin", cache: "no-store", signal: controller.signal
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (response.status === 401) throw new FxRatesError("登录状态已失效，请重新登录");
    if (!response.ok) throw new FxRatesError(force ? "汇率刷新失败，请稍后重试" : "汇率加载失败，请重试");
    return parseFxRatesSnapshot(await response.json());
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    if (timedOut) throw new FxRatesError("汇率请求超时，请重试");
    if (error instanceof FxRatesError) throw error;
    throw new FxRatesError("暂时无法读取汇率，请检查网络后重试");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
