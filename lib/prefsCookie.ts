/**
 * 全站偏好的 cookie 镜像（服务端 / 客户端都能读的纯函数，不要加 "use client"）。
 *
 * 背景：偏好只存 localStorage 的话，服务端首帧只能画默认值，客户端挂载后才切回用户的选择 ——
 * 刷新时会「先闪默认值再跳回」。「加载更多」旁边的「原文 / 简体 / 繁體 / 英文」、展示货币、
 * 卡包排序这些都属于这一类。所以凡是通过 usePersistedState 存的偏好，都会同时镜像到这一个 cookie，
 * 布局（服务端组件）读出来注入首帧，服务端与客户端首帧就都是用户的选择，不再闪。
 */

export const PREFS_COOKIE = "fire_prefs";
/** cookie 单条约 4KB：留出余量给站内其它 cookie（主题、货币、会话） */
const MAX_BYTES = 3000;

export type PrefMap = Record<string, unknown>;

export function parsePrefsCookie(raw: string | null | undefined): PrefMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PrefMap) : {};
  } catch {
    return {};
  }
}

function byteLength(value: string): number {
  // 浏览器限制的是实际写入的编码后长度，中文每字常占 9 字节。
  return encodeURIComponent(value).length;
}

// These small layout preferences must survive a full preference cookie. Otherwise
// the server draws closed navigation and hydration restores the local open state.
const FIRST_FRAME_KEYS = new Set([
  "fire:platform-navigation-expanded", "fire:platform-sidebar-collapsed",
  "fire:tablet-sidebar-collapsed", "fire:site-palette", "fire:theme-mode", "fire:appearance-accent"
]);

/** Keep first-frame layout before optional preferences while respecting the cookie limit. */
export function serializePrefs(map: PrefMap): string {
  const entries = Object.entries(map).filter(([key, value]) => Boolean(key) && value !== undefined);
  const full = JSON.stringify(Object.fromEntries(entries));
  if (byteLength(full) <= MAX_BYTES) return full;
  const sorted = [...entries].sort((a, b) =>
    Number(FIRST_FRAME_KEYS.has(b[0])) - Number(FIRST_FRAME_KEYS.has(a[0]))
    || JSON.stringify(a[1]).length - JSON.stringify(b[1]).length);
  const kept: PrefMap = Object.create(null);
  for (const [key, value] of sorted) {
    if (byteLength(JSON.stringify({ ...kept, [key]: value })) > MAX_BYTES) continue;
    kept[key] = value;
  }
  return JSON.stringify(kept);
}

/** 从 document.cookie 里取出偏好表（只在浏览器里调用） */
export function readPrefsCookie(): PrefMap {
  if (typeof document === "undefined") return {};
  const hit = document.cookie.split("; ").find((item) => item.startsWith(`${PREFS_COOKIE}=`));
  if (!hit) return {};
  const raw = hit.slice(PREFS_COOKIE.length + 1);
  try {
    return parsePrefsCookie(decodeURIComponent(raw));
  } catch {
    return parsePrefsCookie(raw);
  }
}

export function prefsCookieString(map: PrefMap): string {
  const oneYear = 60 * 60 * 24 * 365;
  return `${PREFS_COOKIE}=${encodeURIComponent(serializePrefs(map))}; path=/; max-age=${oneYear}; samesite=lax`;
}
