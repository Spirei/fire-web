"use client";

import { usePersistedState } from "./usePersistedState";

/** Keep both analysis calendars on the same cookie-backed preferences, including legacy raw strings. */
export function usePnlCalendarState() {
  const [savedMarket, setMarket] = usePersistedState("fire:asset-pnl-cal-market", "全部");
  const [savedView, setView] = usePersistedState<"year" | "month">("fire:asset-pnl-cal-view", "month");
  const [savedMode, setMode] = usePersistedState<"收益" | "收益率">("fire:asset-pnl-cal-mode", "收益");
  const [savedMonth, setMonth] = usePersistedState("fire:asset-pnl-cal-month", () => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1 };
  });
  const validMonth = savedMonth && Number.isInteger(savedMonth.y) && Number.isInteger(savedMonth.m) && savedMonth.m >= 1 && savedMonth.m <= 12;
  const now = new Date();
  return {
    market: ["全部", "美股", "港股", "A股"].includes(savedMarket) ? savedMarket : "全部", setMarket,
    view: savedView === "year" ? "year" as const : "month" as const, setView,
    mode: savedMode === "收益率" ? "收益率" as const : "收益" as const, setMode,
    month: validMonth ? savedMonth : { y: now.getFullYear(), m: now.getMonth() + 1 }, setMonth
  };
}
