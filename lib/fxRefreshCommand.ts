import { clientRequestId } from "./randomId";
import { platformRequest, PlatformRequestError } from "./platformRequest";

const KEY = "fire:fx-refresh:pending:v1";
type Receipt = { requestId?: string; id: string; state: string; observation_id?: string | null };
let active: Promise<void> | undefined;

/** Leaving the page stops observation, never the server task or its original UUID. */
export function refreshFxObservation(signal: AbortSignal): Promise<void> {
  return active ??= run(signal).finally(() => { active = undefined; });
}
async function run(signal: AbortSignal) {
  let pending: { requestId: string; taskId?: string } | undefined;
  try { pending = JSON.parse(sessionStorage.getItem(KEY) || "null") ?? undefined; } catch { /* optional persistence */ }
  if (pending && !/^[a-f0-9-]{36}$/.test(pending.requestId)) pending = undefined;
  async function read<T>(path: string, init: RequestInit = {}) {
    return platformRequest<T>(path, { ...init, signal });
  }
  try {
    let receipt: Receipt;
    if (!pending) {
      pending = { requestId: clientRequestId() };
      try { sessionStorage.setItem(KEY, JSON.stringify(pending)); }
      catch { throw new Error("无法保存刷新请求，请检查浏览器存储"); }
      receipt = await read<Receipt>("/api/reference/rates/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: pending.requestId })
      });
      if (receipt.requestId !== pending.requestId) throw new Error("汇率刷新结果尚未确认");
    } else receipt = await read<Receipt>(`/api/reference/rates/operations/${pending.requestId}`);
    for (;;) {
      if (!receipt?.id || pending.taskId && receipt.id !== pending.taskId) throw new Error("汇率刷新结果尚未确认");
      pending.taskId = receipt.id;
      try { sessionStorage.setItem(KEY, JSON.stringify(pending)); } catch { /* optional persistence */ }
      if (receipt.state === "succeeded" && receipt.observation_id) {
        try { sessionStorage.removeItem(KEY); } catch { /* optional persistence */ }
        return;
      }
      if (receipt.state === "failed") {
        try { sessionStorage.removeItem(KEY); } catch { /* optional persistence */ }
        throw new Error("汇率来源读取失败，请检查接口配置");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 750);
        function done() { signal.removeEventListener("abort", stop); resolve(); }
        function stop() { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(signal.reason); }
        if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      });
      receipt = await read<Receipt>(`/api/reference/rates/operations/${pending.requestId}`);
    }
  } catch (error) {
    if (error instanceof PlatformRequestError && [400, 401, 403, 404, 422, 429].includes(error.status ?? 0)) {
      try { sessionStorage.removeItem(KEY); } catch { /* optional persistence */ }
    }
    throw error;
  }
}
