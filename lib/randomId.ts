/**
 * 客户端随机 id。
 *
 * `crypto.randomUUID` 只在安全上下文（https / localhost）提供，通过局域网 HTTP 地址
 * 打开站点时会直接抛 "crypto.randomUUID is not a function"（删除对话、截图粘贴都踩过）。
 * 这里统一改用任何上下文都可用的 `crypto.getRandomValues`，并保留 Math.random 兜底；
 * 输出恒为 24 位小写十六进制，便于像 `ac-<24hex>` 这样的格式校验继续成立。
 */
export function clientRandomId(prefix = ""): string {
  const bytes = new Uint8Array(12);
  try {
    globalThis.crypto?.getRandomValues(bytes);
    return `${prefix}${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    const fallback = Array.from({ length: 12 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");
    return `${prefix}${fallback}`;
  }
}
