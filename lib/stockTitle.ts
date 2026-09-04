export function stripTrailingStockCode(name: string | null | undefined, code: string | null | undefined) {
  const title = (name || "").trim();
  const raw = (code || "").trim();
  if (!title) return "";
  if (!raw) return title;
  const stripped = raw.replace(/^(SH|SZ|BJ|HK)/i, "");
  const digits = stripped.replace(/^0+/, "") || "0";
  const variants = Array.from(new Set([
    raw,
    stripped,
    digits,
    /^\d+$/.test(digits) ? digits.padStart(4, "0") : "",
    /^\d+$/.test(digits) ? digits.padStart(5, "0") : ""
  ].filter(Boolean))).sort((a, b) => b.length - a.length);
  let result = title;
  for (const variant of variants) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?:\\s|[（(\\[]+)+${escaped}[）)\\]]?\\s*$`, "i"), "").trim();
    if (result.length > variant.length && result.toLowerCase().endsWith(variant.toLowerCase())) {
      const before = result.slice(0, -variant.length);
      if (!/[A-Za-z0-9]$/.test(before)) result = before.trim();
    }
  }
  if (variants.some((variant) => result.toLowerCase() === variant.toLowerCase())) return "";
  return result;
}

export function stockTitle(name: string | null | undefined, code: string | null | undefined) {
  const stripped = stripTrailingStockCode(name, code);
  return stripped || (code || "").trim() || (name || "").trim();
}
