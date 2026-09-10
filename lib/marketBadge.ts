import type { MarketBadgeStyle } from "@/lib/types";

export type { MarketBadgeStyle };

/** 设置页与全站色块共用的市场键（A 股按代码拆成 SH / SZ） */
export const MARKET_BADGE_ITEMS: { key: string; name: string }[] = [
  { key: "US", name: "美股" },
  { key: "HK", name: "港股" },
  { key: "SH", name: "A股 · 上证" },
  { key: "SZ", name: "A股 · 深证" },
  { key: "CRYPTO", name: "加密货币" },
  { key: "JP", name: "日股" },
  { key: "KR", name: "韩股" },
  { key: "SG", name: "新加坡" },
  { key: "TW", name: "中国台湾" },
  { key: "UK", name: "英国" },
  { key: "DE", name: "德国" },
  { key: "FR", name: "法国" },
  { key: "AU", name: "澳大利亚" },
  { key: "CA", name: "加拿大" },
  { key: "IN", name: "印度" },
  { key: "BR", name: "巴西" },
  { key: "OTHER", name: "其他市场" }
];

export const MARKET_BADGE_KEYS = MARKET_BADGE_ITEMS.map((item) => item.key);

/** 市场色块默认：US 蓝 / HK 紫 / A股 粉红 / 加密琥珀 / 其余灰 */
export const DEFAULT_MARKET_BADGES: Record<string, MarketBadgeStyle> = {
  US: { label: "US", bg: "#3b82f6", fg: "#ffffff" },
  HK: { label: "HK", bg: "#8b5cf6", fg: "#ffffff" },
  SH: { label: "SH", bg: "#e0919f", fg: "#ffffff" },
  SZ: { label: "SZ", bg: "#e0919f", fg: "#ffffff" },
  JP: { label: "JP", bg: "#6b7280", fg: "#ffffff" },
  KR: { label: "KR", bg: "#6b7280", fg: "#ffffff" },
  SG: { label: "SG", bg: "#6b7280", fg: "#ffffff" },
  TW: { label: "TW", bg: "#6b7280", fg: "#ffffff" },
  UK: { label: "UK", bg: "#6b7280", fg: "#ffffff" },
  DE: { label: "DE", bg: "#6b7280", fg: "#ffffff" },
  FR: { label: "FR", bg: "#6b7280", fg: "#ffffff" },
  AU: { label: "AU", bg: "#6b7280", fg: "#ffffff" },
  CA: { label: "CA", bg: "#6b7280", fg: "#ffffff" },
  IN: { label: "IN", bg: "#6b7280", fg: "#ffffff" },
  BR: { label: "BR", bg: "#6b7280", fg: "#ffffff" },
  CRYPTO: { label: "币", bg: "#d97706", fg: "#ffffff" },
  OTHER: { label: "", bg: "#6b7280", fg: "#ffffff" }
};

function normalizeHex(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return "";
}

export function normalizeMarketBadges(raw: unknown): Record<string, MarketBadgeStyle> {
  const next: Record<string, MarketBadgeStyle> = {};
  MARKET_BADGE_KEYS.forEach((key) => {
    next[key] = { ...DEFAULT_MARKET_BADGES[key] };
  });
  if (!raw || typeof raw !== "object") return next;
  const source = raw as Record<string, unknown>;
  MARKET_BADGE_KEYS.forEach((key) => {
    const item = source[key];
    if (!item || typeof item !== "object") return;
    const row = item as { label?: unknown; bg?: unknown; fg?: unknown };
    const fallback = DEFAULT_MARKET_BADGES[key];
    next[key] = {
      label: typeof row.label === "string" ? row.label.trim().slice(0, 4) : fallback.label,
      bg: normalizeHex(row.bg) || fallback.bg,
      fg: normalizeHex(row.fg) || fallback.fg
    };
  });
  return next;
}

let applied = normalizeMarketBadges(null);
let appliedVisible = true;
let appliedSignature = "";
const listeners = new Set<() => void>();

function notifyMarketBadges() {
  listeners.forEach((fn) => fn());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("fire:market-badges-updated"));
  }
}

/** 写入模块状态，返回是否真的变了（色块定义 + 显隐） */
function setMarketBadges(raw?: unknown, visible?: boolean) {
  const next = normalizeMarketBadges(raw);
  const nextVisible = typeof visible === "boolean" ? visible : appliedVisible;
  const signature = `${nextVisible ? 1 : 0}|${JSON.stringify(next)}`;
  const changed = signature !== appliedSignature;
  applied = next;
  appliedVisible = nextVisible;
  appliedSignature = signature;
  return changed;
}

/**
 * 渲染期使用：只写入模块状态，**不通知订阅者**（渲染期间通知会打断水合、触发跨组件 setState）。
 * 服务端与客户端首帧都要先走这一步，否则 SSR 会用默认值渲染出「显示」的色块 ——
 * 浏览器先画出这版 HTML，等水合后才隐藏，就是「刷新时闪一下市场色块」的原因。
 */
export function primeMarketBadges(raw?: unknown, visible?: boolean) {
  setMarketBadges(raw, visible);
}

/** 提交后使用：写入并通知订阅者（值没变时是空操作） */
export function applyMarketBadges(raw?: unknown, visible?: boolean) {
  if (!setMarketBadges(raw, visible)) return;
  notifyMarketBadges();
}

export function isMarketBadgeVisible() {
  return appliedVisible;
}

function styleOf(key: string): MarketBadgeStyle {
  return applied[key] || DEFAULT_MARKET_BADGES[key] || DEFAULT_MARKET_BADGES.OTHER;
}

/** 市场色块（资产分析-分享页-持仓列表 同款，全局统一） */
export function getMarketBadge(market: string, code: string): MarketBadgeStyle {
  const m = market.toUpperCase();
  if (m === "US") return styleOf("US");
  if (m === "HK") return styleOf("HK");
  if (m === "CN") {
    const first = code.replace(/^\D+/, "").charAt(0);
    return styleOf(first === "6" || first === "9" ? "SH" : "SZ");
  }
  if (m === "ASSET" || m === "CRYPTO") return styleOf("CRYPTO");
  if (applied[m] || DEFAULT_MARKET_BADGES[m]) {
    const style = styleOf(m);
    return { ...style, label: style.label || m };
  }
  const other = styleOf("OTHER");
  return { ...other, label: other.label || m || "US" };
}

export function subscribeMarketBadges(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
