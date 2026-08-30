export function showToast(text: string, type: "ok" | "err" = "ok") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("fire:toast", { detail: { text, type } }));
}
