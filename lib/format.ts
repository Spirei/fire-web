export function fmtNum(n: number | "", digits = 2) {
  if (n === "" || n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 价格数字按市场取小数位：美股（US）3 位，其余 2 位 */
export function fmtNumMarket(n: number | "", market?: string) {
  return fmtNum(n, market === "US" ? 3 : 2);
}

/** 价格显示统一入口：货币符号 + 数字（无效值返回 —），确保所有价格列都带货币符号；
 *  美股（US）保留 3 位小数，其余市场 2 位。 */
export function fmtPrice(n: number | "", currency: string, market?: string) {
  const v = fmtNum(n, market === "US" ? 3 : 2);
  if (v === "—") return v;
  return currency + v;
}

export function fmtQty(n: number | "") {
  if (n === "" || n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

export function fmtMoney(n: number, currency: string) {
  const sign = n < 0 ? "-" : "";
  return sign + currency + Math.abs(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 大数简化（市值等）：万亿 / 亿 / 万，如 4.57 万亿、306.17 亿 */
export function fmtCap(n: number): string {
  if (!n || !Number.isFinite(n)) return "—";
  const v = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (v >= 1e12) return `${sign}${(v / 1e12).toFixed(2)} 万亿`;
  if (v >= 1e8) return `${sign}${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e4) return `${sign}${(v / 1e4).toFixed(2)} 万`;
  return `${sign}${Math.round(v)}`;
}

export function fmtPct(n: number) {
  return (n * 100).toFixed(2) + "%";
}

export function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
}

/** 统一腾讯行情时间（市场当地时间）：YYYY-MM-DD HH:mm */
export function fmtQuoteTime(raw: string): string {
  if (!raw) return "";
  let m: RegExpMatchArray | null;
  // 2026-07-31 16:00:01
  m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  // ISO：2026-07-31T23:59:52+00:00
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  // 2026/07/31 16:08:42
  m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  // 20260731161450
  m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  return raw;
}
