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

/** 货币金额紧凑显示，避免韩元等高面额货币撑破卡片。 */
export function fmtMoneyCompact(n: number, currency: string): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  const format = (amount: number, unit: string) => `${sign}${currency}${amount.toLocaleString("zh-CN", { minimumFractionDigits: amount < 10 ? 2 : 1, maximumFractionDigits: 2 })}${unit}`;
  if (value >= 1e12) return format(value / 1e12, "万亿");
  if (value >= 1e8) return format(value / 1e8, "亿");
  if (value >= 1e4) return format(value / 1e4, "万");
  return fmtMoney(n, currency);
}

/** 七列手机日历专用金额：千位开始缩写，小额省略小数，长货币符号也能装入单元格。 */
export function fmtMoneyCalendarCell(n: number, currency: string): string {
  if (!Number.isFinite(n)) return "—";
  const value = Math.abs(n);
  const compact = (divisor: number, unit: string) =>
    `${currency}${(value / divisor).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 1 })}${unit}`;
  if (value >= 1e8) return compact(1e8, "亿");
  if (value >= 1e4) return compact(1e4, "万");
  if (value >= 1e3) return compact(1e3, "千");
  return `${currency}${Math.round(value).toLocaleString("zh-CN")}`;
}

/** 受宽度约束的金额：常规数值保留完整精度，大数强制使用中文金融单位。 */
export function fmtMoneyAdaptive(n: number, currency: string, compactFrom = 1e7): string {
  return Math.abs(n) >= compactFrom ? fmtMoneyCompact(n, currency) : fmtMoney(n, currency);
}

/** 无货币符号的大数紧凑显示，用于分享卡等符号/币种后置场景。 */
export function fmtNumberCompactZh(n: number, compactFrom = 1e7): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  const format = (amount: number, unit: string) => `${sign}${amount.toLocaleString("zh-CN", { minimumFractionDigits: amount < 10 ? 2 : 1, maximumFractionDigits: 2 })}${unit}`;
  if (value >= 1e12) return format(value / 1e12, "万亿");
  if (value >= 1e8) return format(value / 1e8, "亿");
  if (value >= compactFrom) return format(value / 1e4, "万");
  return `${sign}${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/** 本地日历日期（YYYY-MM-DD）。禁止用 toISOString() 取「今天」——它按 UTC 算，
 *  东八区 00:00-08:00 会得到昨天，用于日期选择 / 默认日期就会错一天。 */
/**
 * 相对时间（主流社交软件的写法）：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / MM-DD HH:MM。
 * 纯函数，`now` 可注入 —— 只在客户端渲染的地方用（服务端渲染会因为「现在」不同而水合不一致）。
 */
export function formatRelativeTime(value: string, now: number = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value || "";
  const diff = now - time;
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  const date = new Date(time);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (time >= startOfToday.getTime() - 24 * 60 * minute && time < startOfToday.getTime()) return `昨天 ${clock}`;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")} ${clock}`;
}

export function localDateKey(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
