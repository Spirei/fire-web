"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronLeft, IconFilter, IconRefresh } from "@tabler/icons-react";
import { Capsule, IconButton } from "@/components/Capsule";
import SafeAssetImage from "@/components/SafeAssetImage";
import { fmtNum, fmtQty } from "@/lib/format";
import { MARKET_CURRENCY } from "@/lib/currency";
import { orderDateKey } from "@/lib/orderTime";
import { platformRequest, PlatformRequestError } from "@/lib/platformRequest";
import type { TradeOrder } from "@/lib/types";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { usePrivateReadRevision } from "@/lib/usePrivateReadRevision";
import styles from "./InvestmentDataManager.module.css";

type Position = {
  recordId: string;
  name?: unknown;
  code?: unknown;
  market?: unknown;
  quantity?: unknown;
  value?: unknown;
  cost?: unknown;
  close?: Record<string, unknown> | null;
  positionTransferEventId?: unknown;
};
type Orders = { orders: TradeOrder[]; coverage: { truncated: boolean } };
const periods = ["本月", "近1月", "近6月", "近1年", "全部"] as const;
type Period = typeof periods[number];

function known(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateBefore(day: string) {
  const value = new Date(day + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function startDate(period: Period, day: string) {
  if (period === "全部") return "";
  if (period === "本月") return day.slice(0, 7) + "-01";
  const value = new Date(day + "T00:00:00Z");
  const dayOfMonth = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() - ({ "近1月": 1, "近6月": 6, "近1年": 12 })[period]);
  const endOfMonth = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(dayOfMonth, endOfMonth));
  return value.toISOString().slice(0, 10);
}

function amount(value: number | null, signed = false) {
  return value === null ? "—" : `${signed && value > 0 ? "+" : ""}${fmtNum(value)}`;
}
const tone = (value: number | null) => value === null ? styles.snapshotMuted : value > 0 ? styles.snapshotPositive : value < 0 ? styles.snapshotNegative : styles.snapshotInk;
const feeKnown = (order: TradeOrder) => order.actualFeeKnown === true || (order.actualFeeKnown !== false
  && (order.feeSource === "owner_recorded" || order.feeSource === "broker_reported"));
const EPSILON = 0.00000001;

export default function SnapshotPositionProfit({ position, day, cutoff, capturedAt, kind, ownerId, sessionCsrf, onBack }: {
  position: Position;
  day: string;
  cutoff: string;
  capturedAt: string;
  kind: "real" | "simulated";
  ownerId: string;
  sessionCsrf: string;
  onBack: () => void;
}) {
  const market = String(position.market || "");
  const name = String(position.name || position.code || "");
  const code = String(position.code || "");
  const currency = String(position.close?.currency || MARKET_CURRENCY[market] || "");
  const { stockIcons } = useAssetIcons(["stock"]);
  const revision = usePrivateReadRevision();
  const heading = useRef<HTMLHeadingElement>(null);
  const [period, setPeriod] = useState<Period>("全部");
  const [custom, setCustom] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [orderRead, setOrderRead] = useState<Orders | null>(null);
  const [openingRead, setOpeningRead] = useState<{ date: string; value: number | null; quantity: number | null }>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(50);
  const start = custom || startDate(period, day);
  const headers = useMemo(() => ({ "X-Alcor-Expected-Account": ownerId, "X-CSRF-Token": sessionCsrf }), [ownerId, sessionCsrf]);

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ scope: "all", recordId: position.recordId, limit: "5000", includeAppOrders: "1", includeOrderHistory: "1" });
    setError("");
    setLoading(true);
    void platformRequest<{ data: Orders }>(`/api/v1/orders?${query}`, { headers, signal: controller.signal }).then(response => {
      if (!controller.signal.aborted) {
        if (!Array.isArray(response.data?.orders) || typeof response.data.coverage?.truncated !== "boolean") throw new Error("订单读取格式无效");
        setOrderRead(response.data);
      }
    }).catch(error => {
      if (!controller.signal.aborted) {
        if (error instanceof PlatformRequestError && [401, 403].includes(error.status ?? 0)) setOrderRead(null);
        setError(error instanceof Error ? error.message : "订单读取失败");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [headers, position.recordId, refresh, revision]);
  useEffect(() => {
    if (!start) return;
    const controller = new AbortController();
    const openingDay = dateBefore(start);
    const query = new URLSearchParams({ day: openingDay, kind });
    void platformRequest<{ day: string; positions: Position[]; equity: unknown }>(`/api/personal-data-transfer/daily-results?${query}`, {
      headers, signal: controller.signal,
    }).then(response => {
      if (controller.signal.aborted) return;
      if (response.day !== openingDay || !Array.isArray(response.positions)) throw new Error("期初快照格式无效");
      const anchor = response.positions.find(item => item.recordId === position.recordId);
      const otherwise = known(response.equity) === null ? null : 0;
      setOpeningRead({ date: openingDay, quantity: anchor ? known(anchor.quantity) : otherwise,
        value: anchor ? (anchor.close?.currency === currency || known(anchor.value) === 0 ? known(anchor.value) : null) : otherwise });
    }).catch(() => {
      if (!controller.signal.aborted) setOpeningRead({ date: openingDay, quantity: null, value: null });
    });
    return () => controller.abort();
  }, [currency, headers, kind, position.recordId, refresh, revision, start]);

  const through = Date.parse(cutoff);
  const savedAt = Date.parse(capturedAt);
  const matched = (orderRead?.orders ?? []).filter(order => order.recordId === position.recordId && order.status === "filled"
    && order.executionModel !== "app_order_mirror");
  const atCutoff = matched.filter(order => Date.parse(order.tradedAt) < through
    && (!order.createdAt || Date.parse(order.createdAt) <= savedAt));
  const since = start ? Date.parse(start + "T00:00:00Z") : -Infinity;
  const selected = atCutoff.filter(order => Date.parse(order.tradedAt) >= since)
    .sort((left, right) => Date.parse(right.tradedAt) - Date.parse(left.tradedAt));
  const close = known(position.value);
  const quantity = known(position.quantity), cost = known(position.cost);
  const current = close !== null && quantity !== null && cost !== null ? close - quantity * cost : null;
  const changedAfterCapture = matched.some(order => (Date.parse(order.tradedAt) < through && Date.parse(order.createdAt) > savedAt)
    || order.orderActivity?.some(event => event.kind !== "filled" && Date.parse(event.timestamp) > savedAt
      && (Date.parse(order.tradedAt) < through || (event.tradeTime && Date.parse(event.tradeTime) < through))));
  const missingDate = !Number.isFinite(through) || !Number.isFinite(savedAt) || matched.some(
    order => !Number.isFinite(Date.parse(order.tradedAt)) || !Number.isFinite(Date.parse(order.createdAt))
  );
  const crossCurrency = selected.some(order => !order.currency || order.currency !== currency
    || (order.settlementCurrency && order.settlementCurrency !== currency));
  const complete = orderRead && !orderRead.coverage.truncated && orderRead.orders.length < 5000 && !error
    && !changedAfterCapture && !missingDate && !position.positionTransferEventId
    && !atCutoff.some(order => order.mergedFromOrderIds?.length || order.historicalCoverageKnown === false);
  const anchor = start && openingRead?.date === dateBefore(start) ? openingRead : null;
  let held = start ? anchor?.quantity ?? null : 0;
  for (const order of [...selected].reverse()) {
    if (held === null || order.side === "dividend") continue;
    const qty = known(order.qty);
    const before = known(order.positionQtyBefore), after = known(order.positionQtyAfter);
    if (qty === null || (before !== null && Math.abs(held - before) > EPSILON)) { held = null; continue; }
    held += order.side === "buy" ? qty : -qty;
    if (held < -EPSILON || (after !== null && Math.abs(held - after) > EPSILON)) held = null;
  }
  const opening = start ? anchor?.value ?? null : 0;
  const feesAvailable = selected.every(order => feeKnown(order) && known(order.fees) !== null);
  const amountAvailable = selected.every(order => known(order.amount) !== null);
  const ledgerTotals = complete && !crossCurrency && amountAvailable;
  const outgoing = ledgerTotals ? selected.filter(order => order.side === "buy").reduce((sum, order) => sum + order.amount, 0) : null;
  const incoming = ledgerTotals ? selected.filter(order => order.side !== "buy").reduce((sum, order) => sum + order.amount, 0) : null;
  const fees = ledgerTotals && feesAvailable ? selected.reduce((sum, order) => sum + order.fees, 0) : null;
  const profit = complete && currency && close !== null && opening !== null && held !== null && quantity !== null
    && Math.abs(held - quantity) <= EPSILON && incoming !== null && outgoing !== null && fees !== null
    ? close - opening + incoming - outgoing - fees : null;
  const lines = selected.flatMap(order => {
    const incoming = order.side !== "buy";
    const title = order.side === "buy" ? "买入" : order.side === "sell" ? "卖出" : "股息";
    const orderCurrency = order.currency || currency;
    const netCurrency = order.settlementCurrency || orderCurrency;
    const base = { id: order.id, day: orderDateKey(order.tradedAt, market), title, incoming, order,
      amount: netCurrency !== orderCurrency ? known(order.settlementAmount) : known(order.amount), currency: netCurrency };
    const fee = feeKnown(order) ? known(order.fees) : null;
    return fee === null || fee === 0 || netCurrency !== orderCurrency ? [base]
      : [base, { ...base, id: order.id + ":fee", title: title + "费用", order: undefined, amount: fee, incoming: false }];
  });
  const rangeStart = start || (selected.at(-1) ? orderDateKey(selected.at(-1)!.tradedAt, market) : "");
  const metrics: [string, number | null][] = [
    ["持仓市值", close], ...(start ? [["期初市值", opening] as [string, number | null]] : []),
    ["累计入账金额", incoming], ["累计出账金额", outgoing], ["已登记费用", fees],
  ];
  return <section className={styles.snapshotProfit} aria-label="个股盈亏详情">
    <div className={styles.snapshotProfitHeader}>
      <IconButton size="md" framed type="button" label="返回持仓视图" onClick={onBack}><IconChevronLeft size={19} /></IconButton>
      <div className="min-w-0 text-center">
        <h3 ref={heading} tabIndex={-1} className="flex items-center justify-center gap-1.5 text-sm font-semibold">
          <SafeAssetImage src={stockIcons[`${market}:${code.toUpperCase()}`]} className="h-5 w-5 rounded-full"
            fallback={<span className="grid h-5 w-5 place-items-center text-[11px]">{name.slice(0, 1)}</span>} />
          <span className="truncate">{name} {code}</span>
        </h3>
        <p className={`mt-0.5 text-[11px] ${styles.snapshotMuted}`}>日终快照 {day}</p>
      </div>
      <IconButton size="md" framed type="button" label="重新读取盈亏" onClick={() => setRefresh(value => value + 1)}><IconRefresh size={18} /></IconButton>
    </div>
    <div className={styles.snapshotProfitPeriods}>
      {periods.map(item => <button key={item} type="button" aria-pressed={period === item && !custom}
        onClick={() => { setPeriod(item); setCustom(""); setFilterOpen(false); setLimit(50); }}>{item}</button>)}
      <IconButton size="sm" type="button" label="自定义起始日期" aria-expanded={filterOpen} onClick={() => setFilterOpen(value => !value)}><IconFilter size={16} /></IconButton>
    </div>
    {filterOpen && <label className={styles.snapshotProfitDate}>开始日期
      <input type="date" min="1900-01-01" max={day} value={custom}
        onChange={event => { const next = event.target.value; if (!next || (next >= "1900-01-01" && next <= day)) { setCustom(next); setLimit(50); } }} />
    </label>}
    <div className={styles.snapshotProfitCard} aria-busy={loading}>
      <p className={styles.snapshotMuted}>{rangeStart && rangeStart !== day ? `${rangeStart} – ` : ""}{day}</p>
      <h4 className="mt-2 font-semibold">累计盈亏{currency ? ` (${currency})` : ""}</h4>
      <strong className={`${styles.snapshotProfitHeadline} ${tone(profit)}`}>{profit === null ? (loading && !orderRead ? "读取中…" : "待核对") : amount(profit, true)}</strong>
      <div className="flex justify-between gap-3 text-xs">期末持仓盈亏 <span className={tone(current)}>{amount(current, true)}</span></div>
    </div>
    <div className={styles.snapshotProfitCard}>
      <h4 className="mb-3 font-semibold">盈亏构成</h4>
      <dl className="space-y-3 text-xs tabular-nums">
        {metrics.map(([label, value]) => <div className="flex justify-between gap-3" key={label}><dt>{label}</dt><dd>{amount(value)}</dd></div>)}
        <div className={styles.snapshotProfitTotal}><dt>盈亏合计</dt><dd className={tone(profit)}>{amount(profit, true)}</dd></div>
      </dl>
      <p className={`mt-2 text-[10px] ${styles.snapshotMuted}`}>期末市值 − 期初市值 + 入账 − 出账 − 费用 · 按当前有效成交核对</p>
    </div>
    <div className={styles.snapshotProfitCard}>
      <h4 className="mb-3 font-semibold">盈亏明细</h4>
      {error ? <p role="alert" className={styles.snapshotMuted}>{error}</p> : !orderRead ? <p role="status" className={styles.snapshotMuted}>读取成交记录…</p>
        : lines.length === 0 ? <p className={styles.snapshotMuted}>所选期间暂无已读取的成交记录</p> :
          <table className={styles.snapshotCashflow} aria-label="盈亏明细">
            <thead><tr>{["时间", "业务类型", "数量/价格", "资金方向", "金额"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
            <tbody>{lines.slice(0, limit).map(line => <tr key={line.id}>
              <td>{line.day.slice(5).replace("-", ".")}<small>{line.day.slice(0, 4)}</small></td>
              <td className={line.order?.side === "buy" ? styles.snapshotPositive : line.order?.side === "sell" ? styles.snapshotNegative : undefined}>{line.title}</td>
              <td>{line.order ? fmtQty(known(line.order.qty) ?? "") : "—"}<small>{line.order ? amount(known(line.order.price)) : "—"}</small></td>
              <td>{line.incoming ? "入账" : "出账"}</td>
              <td>{amount(line.amount)}{line.currency !== currency && <small>{line.currency}</small>}</td>
            </tr>)}</tbody>
          </table>}
      {lines.length > limit && <Capsule variant="ghost" size="sm" onClick={() => setLimit(value => value + 50)}>更多明细</Capsule>}
    </div>
  </section>;
}
