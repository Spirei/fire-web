"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FALLBACK_RATES, type Quote, type StockRecord } from "@/lib/types";
import AssetAnalysisDashboard from "@/components/AssetAnalysisDashboard";
import { useAssetIcons } from "@/lib/useAssetIcons";

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
  const [rates, setRates] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem("fire:rates");
      const parsed = saved ? JSON.parse(saved) : null;
      return { ...FALLBACK_RATES, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    } catch {
      return { ...FALLBACK_RATES };
    }
  });

  const loadRates = useCallback(async () => {
    try {
      const res = await fetch("/api/rates");
      const data = res.ok ? await res.json() : null;
      if (data?.rates) {
        setRates((prev) => ({ ...prev, ...data.rates, USD: 1 }));
        try {
          localStorage.setItem("fire:rates", JSON.stringify(data.rates));
        } catch {
          /* 忽略存储异常 */
        }
      }
    } catch {
      /* 汇率失败保留上次值 */
    }
  }, []);

  useEffect(() => {
    void loadRates();
  }, [loadRates]);

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
