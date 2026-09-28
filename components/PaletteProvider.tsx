"use client";
import { createContext, useCallback, useContext, useLayoutEffect, type ReactNode } from "react";
import { usePersistedState } from "@/lib/usePersistedState";
import { PALETTE_KEY, paletteVariables, resolvePalette, type PaletteId } from "@/lib/palettes";
import { ACCENT_KEY, accentVariables, resolveAccent, type AppearanceAccent } from "@/lib/appearance";
const PaletteContext = createContext<{ palette: PaletteId; choose: (id: PaletteId) => void; accent: AppearanceAccent; chooseAccent: (id: AppearanceAccent) => void }>({ palette: "neutral", choose: () => {}, accent: "blue", chooseAccent: () => {} });
export function applyPalette(id: unknown) {
  const palette = resolvePalette(id);
  const root = document.documentElement;
  root.dataset.palette = palette.id;
  root.dataset.material = palette.glass ? "glass" : "solid";
  Object.entries(paletteVariables(palette.id)).forEach(([key, value]) => root.style.setProperty(key, value));
}
export default function PaletteProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = usePersistedState<PaletteId>(PALETTE_KEY, "neutral");
  const [storedAccent, setAccent] = usePersistedState<AppearanceAccent>(ACCENT_KEY, "blue");
  const accent = resolveAccent(storedAccent).id;
  const palette = resolvePalette(stored).id;
  useLayoutEffect(() => {
    applyPalette(palette);
    document.documentElement.dataset.accent = accent;
    Object.entries(accentVariables(accent)).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
  }, [palette, accent]);
  const choose = useCallback((id: PaletteId) => { setStored(id); }, [setStored]);
  return <PaletteContext.Provider value={{ palette, choose, accent, chooseAccent: setAccent }}>{children}</PaletteContext.Provider>;
}
export const useSitePalette = () => useContext(PaletteContext);
