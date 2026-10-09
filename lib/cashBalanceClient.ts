import { FUND_CURRENCIES, type FundCurrency } from "./fundCurrencies";

export type CashState = { balances: Record<FundCurrency, number>; cardCash: Record<string, number> };
export const cashAmountText = (value: number) => Number(value.toFixed(8)).toString();

export function cashEditPreview(amount: string, balance: unknown, frozen: number, edited: boolean) {
  const available = Number(amount);
  const valid = amount.trim() !== "" && typeof balance === "number" && Number.isFinite(balance)
    && Number.isFinite(available) && available >= 0 && Number.isFinite(frozen) && frozen >= 0 && available + frozen <= 1e12;
  const target = valid ? available + frozen : null;
  const delta = target === null ? null : target - (balance as number);
  return { target, delta, changed: edited && delta !== null && Math.abs(delta) >= 1e-8 };
}

/** Bounded reads and writes. A timed-out save is never automatically replayed. */
export async function requestCashState(body?: { currency: FundCurrency; expectedBalance: number; targetBalance: number }, signal?: AbortSignal): Promise<CashState> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
  try {
    const res = await fetch(body ? "/api/v1/funds" : "/api/v1/funds?balancesOnly=1", { cache: "no-store", signal: controller.signal, ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_balance", ...body }) } : {}) });
    const json = await res.json();
    if (!res.ok || json?.code !== 0 || !json.data?.balances || typeof json.data.balances !== "object" || Array.isArray(json.data.balances) || !FUND_CURRENCIES.every(code => code in json.data.balances && (json.data.balances[code] === null || typeof json.data.balances[code] === "number" && Number.isFinite(json.data.balances[code])))) throw new Error(json?.message || "现金余额暂时无法读取");
    return json.data;
  } catch (reason) {
    if (timedOut) throw new Error(body ? "保存超时，结果尚未确认，请重新读取余额核对" : "读取超时，请重试");
    throw reason;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
}
