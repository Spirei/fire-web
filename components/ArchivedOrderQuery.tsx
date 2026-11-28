"use client";

import { useEffect, useState } from "react";
import TradeOrdersPanel from "@/components/TradeOrdersPanel";
import { readAnalysisOrders } from "@/lib/analysisOrders";
import { PlatformRequestError } from "@/lib/platformRequest";
import { usePrivateReadRevision } from "@/lib/usePrivateReadRevision";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import { useAssetIcons } from "@/lib/useAssetIcons";
import type { TradeOrder } from "@/lib/types";

export default function ArchivedOrderQuery({ ownerId }: { ownerId: string }) {
  const foreground = useWorkspaceForeground();
  const revision = usePrivateReadRevision();
  const { stockIcons } = useAssetIcons(["stock"]);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!foreground) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void readAnalysisOrders(ownerId, controller.signal, true).then(next => {
      if (controller.signal.aborted) return;
      setOrders(next);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof PlatformRequestError && [401, 403].includes(error.status ?? 0)) setOrders([]);
      setError(error instanceof Error ? error.message : "订单读取失败");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [foreground, ownerId, refresh, revision]);
  return <>
    {error && <p role="alert" className="px-3 py-2 text-xs text-muted">{error}</p>}
    <TradeOrdersPanel ownerId={ownerId} orders={orders} loading={loading} stockIcons={stockIcons} bare readOnly
      storageKey="fire:data-management-orders" onRefresh={() => setRefresh(value => value + 1)} />
  </>;
}
