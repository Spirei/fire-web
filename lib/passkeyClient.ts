"use client";

export class PasskeyRequestError extends Error {
  constructor(message: string, public status = 0, public needsRefresh = false) { super(message); }
}

/** Bound network waits, including response-body reads; never replay a credential mutation automatically. */
async function requestJSON(url: string, method: string, body?: unknown, signal?: AbortSignal, timeoutMs = 20000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const verification = method === "POST" && !!body && typeof body === "object" && ["register-verify", "login-verify"].includes(String((body as { action?: unknown }).action));
  const mutation = ["PUT", "PATCH", "DELETE"].includes(method) || verification;
  try {
    const response = await fetch(url, { method, signal: controller.signal, credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
    const data = await response.json().catch(error => {
      if (controller.signal.aborted) throw error;
      return null;
    });
    if (!response.ok) throw new PasskeyRequestError(typeof data?.error === "string" ? data.error : "服务暂不可用，请稍后重试", response.status, response.status === 409 || response.status >= 500 && mutation);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new PasskeyRequestError("服务响应异常，请刷新确认后再试", response.status, mutation);
    return data;
  } catch (error) {
    if (error instanceof PasskeyRequestError || signal?.aborted) throw error;
    throw new PasskeyRequestError(mutation ? "操作结果未确认，请刷新页面后再试" : timedOut ? "请求超时，请检查网络后重试" : "网络连接失败，请稍后重试", 0, mutation);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export const passkeyRead = (url: string, signal?: AbortSignal, timeoutMs = 15000) => requestJSON(url, "GET", undefined, signal, timeoutMs);
export const passkeyRequest = (body: unknown, method = "POST", url = "/api/auth/passkeys", signal?: AbortSignal, timeoutMs = 20000) => requestJSON(url, method, body, signal, timeoutMs);
export function passkeyError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") return "操作已取消或超时，可重新尝试";
    if (error.name === "InvalidStateError") return "此密码管理器中已有该账号的通行密钥，请选择其他保存位置";
    if (error.name === "SecurityError") return "请通过管理员配置的 HTTPS 站点地址使用通行密钥";
    if (/[\u4e00-\u9fff]/.test(error.message)) return error.message;
  }
  return "通行密钥操作未完成，请重试或使用密码登录";
}
