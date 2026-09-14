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
