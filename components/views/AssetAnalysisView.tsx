"use client";

import { useCallback, useMemo } from "react";
import { type Quote, type StockRecord } from "@/lib/types";
import AssetAnalysisDashboard from "@/components/AssetAnalysisDashboard";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { useRates } from "@/lib/useRates";

interface Props {
  records: StockRecord[];
  quotes: Record<string, Quote>;
  livePrice: (r: StockRecord) => number;
  user?: { username?: string; nickname?: string; avatar?: string };
  refreshQuotes?: (options?: { force?: boolean }) => Promise<void>;
  onOpenPnlAnalysis?: () => void;
}

/** 独立页签：资产分析（从我的持仓剥离），行情/汇率/记录刷新与持仓页共用链路 */
export default function AssetAnalysisView({ records, quotes, livePrice, user, refreshQuotes, onOpenPnlAnalysis }: Props) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const rates = useRates();

  const positions = useMemo(() => records.filter((r) => Number(r.qty) > 0), [records]);

  // 区域刷新：只强制重取当前行情，不重载汇率 / 记录，避免连带刷新收益率趋势图与总资产趋势图；无感无提示
  const refreshMarketData = useCallback(async () => {
    await refreshQuotes?.({ force: true });
  }, [refreshQuotes]);

  return (
    <AssetAnalysisDashboard
      positions={positions}
      quotes={quotes}
      livePrice={livePrice}
      rates={rates}
      currency="USD"
      stockIcons={stockIcons}
      user={user}
      onRefreshMarketData={refreshMarketData}
      onOpenPnlAnalysis={onOpenPnlAnalysis}
    />
  );
}
