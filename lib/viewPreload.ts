"use client";

// 仅在导航意图明确时取页面代码；不提前挂载，也不调用页面的数据接口。
const loaders: Record<string, () => Promise<unknown>> = {
  holdings: () => import("@/components/views/HoldingsView"),
  watchlist: () => import("@/components/views/WatchlistView"),
  // Prime the nested trend chunk alongside the page on navigation intent, not after its first render.
  // Importing code does not mount charts or start their data requests.
  assets: () => Promise.all([
    import("@/components/views/AssetAnalysisView"),
    import("@/components/PnlTrendChart")
  ]),
  fire: () => import("@/components/views/FireView"),
  activities: () => import("@/components/views/ActivitiesView"),
  earnings: () => import("@/components/views/EarningsCalendarView"),
  celebs: () => import("@/components/views/CelebsView"),
  trading: () => import("@/components/views/FeedView"),
  settings: () => import("@/components/views/SettingsView"),
  users: () => import("@/components/views/UsersView"),
  library: () => import("@/components/views/AssetLibraryView"),
  cards: () => import("@/components/views/CardLibraryView"),
  attachments: () => import("@/components/views/AttachmentsView"),
  global: () => import("@/components/views/GlobalPreviewView"),
  pnl: () => import("@/components/AssetPnlAnalysis"),
  assistant: () => import("@/components/views/AssistantView")
};
const loaded = new Map<string, Promise<void>>();

export function preloadView(key: string) {
  if (typeof navigator === "undefined") return;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType ?? "")) return;
  if (!Object.prototype.hasOwnProperty.call(loaders, key)) return;
  const existing = loaded.get(key);
  if (existing) return existing;
  const pending = loaders[key]().then(() => {}, () => { loaded.delete(key); });
  loaded.set(key, pending);
  return pending;
}
