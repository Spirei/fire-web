"use client";

// 复制文本：优先 Clipboard API，失败时回退到 textarea + execCommand（兼容 http / 权限受限环境）
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
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
