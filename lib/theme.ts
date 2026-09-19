/** 主题同步：localStorage 记忆 + Cookie 供服务端 SSR 首帧使用（避免暗黑刷新白屏） */

export const THEME_COOKIE = "fire_theme";
export const THEME_KEY = "fire.theme";
export const THEME_CHANGE_EVENT = "fire:theme-change";
export type SiteTheme = "light" | "dark";
const LEGACY_THEME_COOKIE = "sto" + "cklog_theme";

export function setThemeCookie(dark: boolean) {
  try {
    document.cookie = `${THEME_COOKIE}=${dark ? "dark" : "light"}; path=/; max-age=31536000; SameSite=Lax`;
    document.cookie = `${LEGACY_THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    /* 忽略 Cookie 写入异常 */
  }
}

/**
 * 服务端读主题：从请求头里的 cookie 串解析（根布局与首页首帧都用它）。
 * 没写过 cookie 的访客默认深色 —— 首页本来就是夜景，浅色是用户自己切过的选择。
 */
export function readThemeFromCookieHeader(cookieHeader: string): SiteTheme {
  const read = (name: string) => {
    const matched = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (!matched) return "";
    try {
      return decodeURIComponent(matched[1]);
    } catch {
      return matched[1];
    }
  };
  const value = read(THEME_COOKIE) || read(LEGACY_THEME_COOKIE);
  return value === "light" ? "light" : "dark";
}

export function applySiteTheme(theme: SiteTheme, emit = true) {
  if (typeof document === "undefined") return;
  const dark = theme === "dark";
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 忽略存储异常 */ }
  setThemeCookie(dark);
  // Theme listeners can update React state. Defer the notification so a theme
  // change triggered by another component never runs those updates mid-render.
  if (emit) {
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
    });
  }
}
