/** 主题同步：localStorage 记忆 + Cookie 供服务端 SSR 首帧使用（避免暗黑刷新白屏） */

export const THEME_COOKIE = "fire_theme";
const LEGACY_THEME_COOKIE = "sto" + "cklog_theme";

export function setThemeCookie(dark: boolean) {
  try {
    document.cookie = `${THEME_COOKIE}=${dark ? "dark" : "light"}; path=/; max-age=31536000; SameSite=Lax`;
    document.cookie = `${LEGACY_THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    /* 忽略 Cookie 写入异常 */
  }
}
