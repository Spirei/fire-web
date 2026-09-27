export type ToastType = "ok" | "err" | "cancel";

export function conciseToast(text: string): string {
  const value = text.trim();
  if (/^已取消(?:未保存的修改|修改|操作)?$/.test(value)) return "已取消";
  if (/^[^：:，,。\n]+(?:已自动保存|已保存|保存成功)$/.test(value) || value === "保存成功") return "已保存";
  if (/^[^：:，,。\n]+(?:已复制|复制成功)$/.test(value) || value === "复制成功") return "已复制";
  if (/^[^：:，,。\n]+(?:已删除|删除成功)$/.test(value) || value === "删除成功") return "已删除";
  if (/^[^：:，,。\n]+保存失败$/.test(value)) return "保存失败";
  if (/^[^：:，,。\n]+复制失败$/.test(value)) return "复制失败";
  return value;
}

export function showToast(text: string, type: ToastType = "ok") {
  if (typeof window === "undefined") return;
  const concise = conciseToast(text);
  if (!concise) return;
  window.dispatchEvent(new CustomEvent("fire:toast", { detail: { text: concise, type: type === "ok" && concise === "已取消" ? "cancel" : type } }));
}
