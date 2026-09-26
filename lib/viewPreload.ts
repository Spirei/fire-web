"use client";

// 仅在导航意图明确时取页面代码；不提前挂载，也不调用页面的数据接口。
const loaders: Record<string, () => Promise<unknown>> = {
  holdings: () => import("@/components/views/HoldingsView"),
  watchlist: () => import("@/components/views/WatchlistView"),
  assets: () => import("@/components/views/AssetAnalysisView"),
  fire: () => import("@/components/views/FireView"),
  activities: () => import("@/components/views/ActivitiesView"),
  earnings: () => import("@/components/views/EarningsCalendarView"),
  celebs: () => import("@/components/views/CelebsView"),
  trading: () => import("@/components/views/TradingSquareView"),
  settings: () => import("@/components/views/SettingsView"),
  users: () => import("@/components/views/UsersView"),
  library: () => import("@/components/views/AssetLibraryView"),
  cards: () => import("@/components/views/CardLibraryView"),
  attachments: () => import("@/components/views/AttachmentsView"),
  global: () => import("@/components/views/GlobalPreviewView"),
  pnl: () => import("@/components/AssetPnlAnalysis"),
  assistant: () => import("@/components/views/AssistantView")
};
const loaded = new Set<string>();

export function preloadView(key: string) {
  if (typeof navigator === "undefined") return;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType ?? "")) return;
  if (!Object.prototype.hasOwnProperty.call(loaders, key) || loaded.has(key)) return;
  loaded.add(key);
  void loaders[key]().catch(() => loaded.delete(key));
}
