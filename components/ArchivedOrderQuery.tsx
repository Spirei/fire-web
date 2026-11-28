"use client";

import { useEffect, useRef, useState } from "react";
import TradeOrdersPanel from "@/components/TradeOrdersPanel";
import { readAnalysisOrders } from "@/lib/analysisOrders";
import { PlatformRequestError } from "@/lib/platformRequest";
import { usePrivateReadRevision } from "@/lib/usePrivateReadRevision";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import { useAssetIcons } from "@/lib/useAssetIcons";
import type { TradeOrder } from "@/lib/types";

const FRESH_FOR = 30_000;

export default function ArchivedOrderQuery({ ownerId, active }: { ownerId: string; active: boolean }) {
  const foreground = useWorkspaceForeground();
  const revision = usePrivateReadRevision();
  const { stockIcons } = useAssetIcons(["stock"]);
  const [result, setResult] = useState<{ ownerId: string; orders: TradeOrder[] }>();
  const lastRead = useRef<{ ownerId: string; revision: number; refresh: number; at: number }>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const invalidate = () => setRefresh(value => value + 1);
    window.addEventListener("fire:orders-updated", invalidate);
    return () => window.removeEventListener("fire:orders-updated", invalidate);
  }, []);
  useEffect(() => {
    if (!foreground || !active) return;
    const previous = lastRead.current;
    if (previous?.ownerId === ownerId && previous.revision === revision && previous.refresh === refresh
        && Date.now() - previous.at < FRESH_FOR) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void readAnalysisOrders(ownerId, controller.signal, true).then(next => {
      if (controller.signal.aborted) return;
      lastRead.current = { ownerId, revision, refresh, at: Date.now() };
      setResult({ ownerId, orders: next });
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof PlatformRequestError && [401, 403, 409].includes(error.status ?? 0)) {
        lastRead.current = null;
        setResult(undefined);
      }
      setError(error instanceof Error ? error.message : "订单读取失败");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, foreground, ownerId, refresh, revision]);

  if (!active) return null;
  return <>
    {error && <p role="alert" className="px-3 py-2 text-xs text-muted">{error}</p>}
    <TradeOrdersPanel ownerId={ownerId} orders={result?.ownerId === ownerId ? result.orders : []} loading={loading} stockIcons={stockIcons} bare readOnly
      storageKey="fire:data-management-orders" onRefresh={() => setRefresh(value => value + 1)} />
  </>;
}
