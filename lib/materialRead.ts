/** Bounded read only; proxy/login HTML must never escape as a JSON parser error. */
export async function readMaterialResponse(url: string, signal: AbortSignal): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 10000);
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } });
      if (response.status === 401 || response.redirected) throw new Error("登录状态已失效，请重新登录");
      if (response.status === 403) throw new Error("没有读取此素材的权限");
      const data = await response.json().catch(() => null);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (response.ok && data && typeof data === "object" && !Array.isArray(data)) return data;
      if (attempt === 0 && (response.ok || [502, 503, 504].includes(response.status))) continue;
      throw new Error(response.status === 429 ? "读取过于频繁，请稍后重试" : "素材暂时无法读取，请重试");
    } catch (error) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (error instanceof Error && error.name !== "AbortError" && !(error instanceof TypeError)) throw error;
      if (attempt) throw new Error("素材读取超时或网络不可用，请重试");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  throw new Error("素材暂时无法读取，请重试");
}
