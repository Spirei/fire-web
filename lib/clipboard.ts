"use client";

// 复制文本：优先 Clipboard API，失败时回退到 textarea + execCommand（兼容 http / 权限受限环境）
export async function copyText(text: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      const write = navigator.clipboard.writeText(text);
      await (signal ? waitForCopy(write, signal) : write);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  return copyTextFallback(text);
}

function copyTextFallback(text: string): boolean {
  let ta: HTMLTextAreaElement | null = null;
  const previousFocus = document.activeElement;
  try {
    ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    return ok;
  } catch {
    return false;
  } finally {
    // Never leave copied credentials in the DOM, even when the browser rejects copying.
    if (ta) { ta.value = ""; ta.remove(); }
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

function waitForCopy<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("请求已取消", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Start clipboard access during the click, before asynchronously loading protected text (Safari). */
export async function copyTextFrom(load: () => Promise<string>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
  const text = waitForCopy(Promise.resolve().then(() => {
    if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
    return load();
  }), signal);
  // Some browsers reject clipboard access before consuming the promised data.
  void text.catch(() => {});
  if (window.isSecureContext && typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function") {
    const blob = text.then(value => new Blob([value], { type: "text/plain" }));
    void blob.catch(() => {});
    try {
      const item = new ClipboardItem({ "text/plain": blob });
      await waitForCopy(navigator.clipboard.write([item]), signal);
      return true;
    } catch {
      const value = await text; // Preserve read errors; never copy an error message.
      if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
      return copyTextFallback(value);
    }
  }
  const value = await text;
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
  return copyText(value, signal);
}
