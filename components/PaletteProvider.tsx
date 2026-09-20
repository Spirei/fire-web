"use client";
import { createContext, useCallback, useContext, useLayoutEffect, type ReactNode } from "react";
import { usePersistedState } from "@/lib/usePersistedState";
import { PALETTE_KEY, paletteVariables, resolvePalette, type PaletteId } from "@/lib/palettes";
import LiquidGlassInteractions from "./LiquidGlassInteractions";
const PaletteContext = createContext<{ palette: PaletteId; choose: (id: PaletteId) => void }>({ palette: "neutral", choose: () => {} });
export function applyPalette(id: unknown) {
  const palette = resolvePalette(id);
  const root = document.documentElement;
  root.dataset.palette = palette.id;
  root.dataset.material = palette.glass ? "glass" : "solid";
  Object.entries(paletteVariables(palette.id)).forEach(([key, value]) => root.style.setProperty(key, value));
}
export default function PaletteProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = usePersistedState<PaletteId>(PALETTE_KEY, "neutral");
  const palette = resolvePalette(stored).id;
  useLayoutEffect(() => applyPalette(palette), [palette]);
  const choose = useCallback((id: PaletteId) => { applyPalette(id); setStored(id); }, [setStored]);
  return <PaletteContext.Provider value={{ palette, choose }}>{children}<LiquidGlassInteractions enabled={palette === "liquid"} /></PaletteContext.Provider>;
}
export const useSitePalette = () => useContext(PaletteContext);
