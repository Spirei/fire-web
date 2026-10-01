import type { FeedJob, FeedPayload } from "./feedTypes";

export class FeedRequestError extends Error {
  constructor(message: string, public status = 0, public unconfirmed = false) { super(message); }
}

/** One bounded, same-origin request; writes are never automatically replayed. */
export async function feedRequest<T>(path = "", method = "GET", body?: unknown, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`/api/v1/feed${path}`, {
      method, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let value;
    try { value = await response.json(); }
    catch { throw new FeedRequestError(method === "GET" ? "服务响应暂时不可用，请重试" : "服务响应不完整，操作结果尚未确认，请先重新读取", response.status, method !== "GET"); }
    if (!response.ok || value?.code !== 0) throw new FeedRequestError(value?.message || "暂时无法连接，请重试", response.status, method !== "GET" && (response.status >= 502 || response.ok));
    return value.data as T;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    if (timedOut) throw new FeedRequestError(method === "GET" ? "读取超时，请重试" : "请求超时，操作结果尚未确认，请先重新读取", 0, method !== "GET");
    if (error instanceof FeedRequestError) throw error;
    throw new FeedRequestError(method === "GET" ? "暂时无法连接，请检查网络后重试" : "连接中断，操作结果尚未确认，请先重新读取", 0, method !== "GET");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export const feedJobRunning = (job: FeedJob | null) => !!job && ["queued", "searching", "writing"].includes(job.status);

export function feedEmptyCopy(data: FeedPayload) {
  if (!data.preferences.instructions) return { title: "你的动态，由你来定义", body: "告诉 Alcor 你想关注什么。大新闻、公司动向、科技进展，或任何你感兴趣的话题——把值得关注的变化，变成容易读完的动态。" };
  if (feedJobRunning(data.job)) return { title: "正在寻找值得关注的变化", body: "Alcor 正在按你的指示搜集来源、提炼重点。可以离开页面，稍后回来查看。" };
  if (!data.capabilities.generate) return { title: "准备好你的第一条动态", body: "指示已保存。连接大模型服务后，Alcor 才能搜集来源、提炼重点；已有内容不会受影响。" };
  if (data.job?.status === "error") return { title: "这次更新还没有完成", body: "你的指示已保留，没有生成未经核实的内容。可以重试，或调整关注范围。" };
  return { title: "还没有可显示的动态", body: data.job?.status === "done" ? `这次没有可显示的新内容。${data.preferences.enabled ? "之后会继续按你的指示更新" : "可以在右上角手动更新"}，也可以调整关注范围，稍后再看看。` : "指示已保存，点右上角更新即可开始。每条动态都会保留来源，修改指示不会替换已有内容。" };
}
