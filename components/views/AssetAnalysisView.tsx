"use client";

import { sharedRead } from "@/lib/sharedRead";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { FALLBACK_RATES, type Quote, type StockRecord } from "@/lib/types";
import AssetAnalysisDashboard from "@/components/AssetAnalysisDashboard";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { readCachedRates, writeCachedRates } from "@/lib/ratesCache";

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
  // 首帧必须与服务端一致：只用兜底汇率，挂载后（绘制前）再合并浏览器里缓存的实时汇率
  const [rates, setRates] = useState<Record<string, number>>(() => ({ ...FALLBACK_RATES }));
  useLayoutEffect(() => {
    const cached = readCachedRates();
    if (cached) setRates((prev) => ({ ...prev, ...cached }));
  }, []);

  const loadRates = useCallback(async () => {
    try {
      const res = await sharedRead("/api/rates");
      const data = res.ok ? await res.json() : null;
      if (data?.rates) {
        setRates((prev) => ({ ...prev, ...data.rates, USD: 1 }));
        writeCachedRates(data.rates);
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
