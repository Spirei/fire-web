/** JSON requests for the private platform. Unknown writes are never replayed. */
export class PlatformRequestError extends Error {
  status?: number;
  reauthentication = false;
}

function message(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return message(item.message ?? item.detail ?? item.error);
  }
  return "请求失败";
}

export async function platformRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 30000, conditional?: { etag: string; value: T }): Promise<T> {
  const reading = !init.method || ["GET", "HEAD"].includes(init.method.toUpperCase());
  if (conditional && !reading) throw new Error("条件读取不适用于写入请求");
  const controller = new AbortController();
  const parent = init.signal;
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const headers = new Headers(init.headers);
  if (conditional) headers.set("if-none-match", conditional.etag);
  const timer = setTimeout(() => controller.abort(new Error(reading ? "读取超时，请重试" : "请求超时，请核对结果后再操作")), timeoutMs);
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(controller.signal.reason ?? new DOMException("请求已取消", "AbortError"));
    if (controller.signal.aborted) stop();
    else controller.signal.addEventListener("abort", stop, { once: true });
  });
  try {
    if (controller.signal.aborted) return await aborted;
    return await Promise.race([aborted, (async () => {
      let response: Response;
      try {
        response = await fetch(path, { cache: "no-store", ...init, headers, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof TypeError) throw new Error(reading ? "网络连接中断，请重试" : "网络连接中断，请核对结果后再操作");
        throw error;
      }
      if (response.status === 204) return undefined as T;
      if (response.status === 304 && conditional) return conditional.value;
      let data: unknown;
      try { data = await response.json(); }
      catch {
        if (response.ok) throw new Error("响应格式无效，请重新读取");
      }
      if (!response.ok) {
        const error = new PlatformRequestError(data == null ? "服务暂时不可用，请稍后核对结果" : message(data));
        error.status = response.status;
        error.reauthentication = response.headers.get("x-alcor-reauthentication") === "required";
        throw error;
      }
      return data as T;
    })()]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    if (stop) controller.signal.removeEventListener("abort", stop);
  }
}
