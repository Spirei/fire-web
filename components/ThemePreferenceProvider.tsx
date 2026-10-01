"use client";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { usePersistedState } from "@/lib/usePersistedState";
import { applySiteTheme, effectiveTheme, resolveThemeMode, THEME_CHANGE_EVENT, THEME_MODE_KEY, type SiteTheme, type SiteThemeMode } from "@/lib/theme";
const ThemePreferenceContext = createContext<{ mode: SiteThemeMode; choose: (mode: SiteThemeMode) => void }>({ mode: "dark", choose: () => {} });
export default function ThemePreferenceProvider({ children, initialTheme }: { children: ReactNode; initialTheme: SiteTheme }) {
  const pathname = usePathname();
  const [stored, setMode] = usePersistedState<SiteThemeMode>(THEME_MODE_KEY, initialTheme);
  const mode = resolveThemeMode(stored, initialTheme);
  useEffect(() => {
    if (pathname === "/simple-app") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.themeMode = mode;
      const theme = effectiveTheme(mode, media.matches);
      applySiteTheme(theme, false);
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme, mode } }));
    };
    apply();
    if (mode !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode, pathname]);
  useEffect(() => {
    // Existing theme toggles are explicit overrides; provider notifications include mode.
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ theme?: SiteTheme; mode?: SiteThemeMode }>).detail;
      if (!detail?.mode && (detail?.theme === "light" || detail?.theme === "dark")) setMode(detail.theme);
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, [setMode]);
  return <ThemePreferenceContext.Provider value={{ mode, choose: setMode }}>{children}</ThemePreferenceContext.Provider>;
}
export const useThemePreference = () => useContext(ThemePreferenceContext);
