/** 市场色块（资产分析-分享页-持仓列表 同款，全局统一）：US 蓝 / HK 紫 / A股 按代码 SH/SZ 粉红 */
export function getMarketBadge(market: string, code: string): { label: string; bg: string; fg: string } {
  const m = market.toUpperCase();
  if (m === "US") return { label: "US", bg: "#3b82f6", fg: "#ffffff" };
  if (m === "HK") return { label: "HK", bg: "#8b5cf6", fg: "#ffffff" };
  if (m === "CN") {
    const first = code.replace(/^\D+/, "").charAt(0);
    const isSH = first === "6" || first === "9";
    return { label: isSH ? "SH" : "SZ", bg: "#e0919f", fg: "#ffffff" };
  }
  if (m === "ASSET" || m === "CRYPTO") return { label: "币", bg: "#d97706", fg: "#ffffff" };
  return { label: m || "US", bg: "#6b7280", fg: "#ffffff" };
}
