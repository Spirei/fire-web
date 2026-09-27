"use client";
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { usePersistedState } from "@/lib/usePersistedState";
import { FONT_KEY, FONT_WEIGHT_KEY, resolveFont, resolveFontWeight, typographyVariables, type SiteFont, type SiteFontWeight } from "@/lib/typography";
const TypographyContext = createContext<{ font: SiteFont; weight: SiteFontWeight; chooseFont: (font: SiteFont) => void; chooseWeight: (weight: SiteFontWeight) => void }>({ font: "system", weight: 400, chooseFont: () => {}, chooseWeight: () => {} });
export default function TypographyProvider({ children }: { children: ReactNode }) {
  const [storedFont, chooseFont] = usePersistedState<SiteFont>(FONT_KEY, "system");
  const [storedWeight, chooseWeight] = usePersistedState<SiteFontWeight>(FONT_WEIGHT_KEY, 400);
  const font = resolveFont(storedFont).id;
  const weight = resolveFontWeight(storedWeight);
  useLayoutEffect(() => {
    Object.entries(typographyVariables(font, weight)).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
  }, [font, weight]);
  return <TypographyContext.Provider value={{ font, weight, chooseFont, chooseWeight }}>{children}</TypographyContext.Provider>;
}
export const useTypography = () => useContext(TypographyContext);
