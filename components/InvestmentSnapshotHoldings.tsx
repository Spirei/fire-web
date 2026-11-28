"use client";

import { useEffect, useMemo, useState } from "react";
import { IconArrowUpRight, IconChevronDown, IconFileDescription } from "@tabler/icons-react";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import MarketIcon from "@/components/MarketIcon";
import SafeAssetImage from "@/components/SafeAssetImage";
import { MARKET_CURRENCY } from "@/lib/currency";
import { marketMeta } from "@/lib/types";
import { ensureStockIcons, useAssetIcons } from "@/lib/useAssetIcons";
import styles from "./InvestmentDataManager.module.css";

type Data = Record<string, unknown>;
type Position = Data & { recordId: string; close: Data | null };
type SortKey = "value" | "close" | "pnl";
type Sort = { key: SortKey; ascending: boolean };

const sortedColumns = [
  { key: "value", label: "市值/数量" },
  { key: "close", label: "收盘/成本" },
  { key: "pnl", label: "日终盈亏" },
] as const;

function decimal(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function amount(value: number | null, digits = 0) {
  return value === null ? "—" : value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 8) });
}

function signed(value: number | null, digits: number, unit = "") {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${amount(value, digits)}${unit}`;
}

const tone = (value: number | null) => value === null || value === 0 ? styles.snapshotInk : value > 0 ? styles.snapshotPositive : styles.snapshotNegative;

function total(values: (number | null)[]) {
  if (!values.length || values.some(value => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function holdingValue(position: Position, currency: string) {
  const value = decimal(position.value);
  return value === 0 || position.close?.currency === currency ? value : null;
}

export default function InvestmentSnapshotHoldings({ positions, calendar, onOpen, onProfit }: {
  positions: Position[];
  calendar?: { rows?: Data[] } | null;
  onOpen: (id: string, revision?: number) => void;
  onProfit: (id: string, trigger: HTMLButtonElement) => void;
}) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sorts, setSorts] = useState<Record<string, Sort | undefined>>({});
  const markets = useMemo(() => {
    const groups = new Map<string, Position[]>();
    for (const position of positions) {
      const market = String(position.market || "OTHER");
      const rows = groups.get(market) ?? [];
      rows.push(position);
      groups.set(market, rows);
    }
    return groups;
  }, [positions]);
  const daily = useMemo(() => new Map((calendar?.rows ?? []).map(row => [row.recordId, row])), [calendar]);

  useEffect(() => {
    void ensureStockIcons(positions.flatMap(position => typeof position.code === "string" && typeof position.market === "string"
      ? [{ market: position.market, code: position.code }] : []));
  }, [positions]);

  function changeSort(market: string, key: SortKey) {
    setSorts(current => {
      const existing = current[market];
      const next = existing?.key !== key ? { key, ascending: false } : !existing.ascending ? { key, ascending: true } : undefined;
      return { ...current, [market]: next };
    });
  }

  if (!positions.length) return <p className="px-2 py-6 text-sm text-muted">本版快照没有持仓记录</p>;
  return (
    <section className={styles.snapshotHoldings} aria-label="日终持仓分布">
      <h4 className="px-3 pt-3 text-sm font-semibold sm:px-5">持仓分布</h4>
      {[...markets].map(([market, rows]) => {
        const currency = MARKET_CURRENCY[market] ?? "";
        const profitRows = (calendar?.rows ?? []).filter(row => row.market === market && row.currency === currency);
        const marketValue = total(rows.map(row => holdingValue(row, currency)));
        const holdingPnl = total(rows.map(position => {
          const value = holdingValue(position, currency);
          const quantity = decimal(position.quantity), cost = decimal(position.cost);
          if (quantity === 0 && value === 0) return 0;
          return value !== null && quantity !== null && cost !== null ? value - quantity * cost : null;
        }));
        const dailyPnl = total(profitRows.map(row => decimal(row.profit)));
        const sort = sorts[market];
        const listed = sort ? [...rows].sort((left, right) => {
          const value = (position: Position) => sort.key === "pnl" ? decimal(daily.get(position.recordId)?.profit)
            : sort.key === "close" ? decimal(position.close?.value) : holdingValue(position, currency);
          const a = value(left), b = value(right);
          if (a === null || b === null) return Number(a === null) - Number(b === null);
          return sort.ascending ? a - b : b - a;
        }) : rows;
        return <details key={market} open className={`group ${styles.snapshotMarket}`}>
          <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <MarketIcon market={market} size={23} />
            <span>{marketMeta(market).label}</span>
            <span className="font-medium tabular-nums">{amount(marketValue, 2)}{marketValue === null || !currency ? "" : ` ${currency}`}</span>
            <IconChevronDown size={13} aria-hidden="true" className={`${styles.snapshotMuted} group-open:rotate-180`} />
          </summary>
          <dl className={styles.snapshotMarketMetrics}>
            <div><dt>持仓市值</dt><dd>{amount(marketValue, 2)}</dd></div>
            <div><dt>持仓盈亏</dt><dd className={tone(holdingPnl)}>{signed(holdingPnl, 2)}</dd></div>
            <div><dt>日终盈亏</dt><dd className={tone(dailyPnl)}>{signed(dailyPnl, 2)}</dd></div>
          </dl>
          <table className="w-full table-fixed text-xs tabular-nums" aria-label={`${marketMeta(market).label}持仓`}>
            <thead className={`text-[10px] sm:text-[11px] ${styles.snapshotMuted}`}>
              <tr>
                <th scope="col" className="w-[32%] py-2 text-left font-medium">名称/代码</th>
                {sortedColumns.map(({ key, label }) => <th scope="col" key={key}
                  className="py-2 pl-1 text-right font-medium"
                  aria-sort={sort?.key === key ? sort.ascending ? "ascending" : "descending" : undefined}>
                  <button type="button" onClick={() => changeSort(market, key)} className="inline-flex items-center gap-0.5 whitespace-nowrap">
                    {label}
                    <span className="inline-flex flex-col text-[7px] leading-[6px]" aria-hidden="true">
                      <span className={sort?.key === key && sort.ascending ? styles.snapshotInk : "opacity-50"}>▲</span>
                      <span className={sort?.key === key && !sort.ascending ? styles.snapshotInk : "opacity-50"}>▼</span>
                    </span>
                  </button>
                </th>)}
              </tr>
            </thead>
            {listed.map(position => {
              const name = String(position.name || position.code || "—");
              const code = String(position.code || "—");
              const row = daily.get(position.recordId);
              const profit = row?.currency === currency ? decimal(row?.profit) : null;
              const capital = decimal(row?.capital);
              const percent = profit !== null && capital !== null && capital > 0 ? profit / capital * 100 : null;
              const isExpanded = expanded === position.recordId;
              return <tbody key={position.recordId}>
                <tr className={`${styles.snapshotHoldingRow} cursor-pointer align-middle`} onClick={() => {
                  setExpanded(isExpanded ? null : position.recordId);
                }}>
                  <th scope="row" className="py-2.5 text-left font-medium">
                    <button type="button" className={`flex w-full min-w-0 items-center gap-1.5 text-left sm:gap-2 ${styles.snapshotInk}`}
                      aria-expanded={isExpanded}>
                      <span className="relative flex-none">
                        <SafeAssetImage src={stockIcons[`${market}:${code.toUpperCase()}`]} className="h-6 w-6 rounded-full"
                          fallback={<span className={`grid h-6 w-6 place-items-center text-[10px] ${styles.snapshotIconFallback}`}>{name.slice(0, 1)}</span>} loading="lazy" />
                        <EtfDoubleBadge market={market} code={code} name={name} className="!-bottom-1 !h-3.5 !w-3.5 !text-[7px]" />
                      </span>
                      <span className="min-w-0">
                        <span className={styles.snapshotHoldingName} title={name}>{name}</span>
                        <small className={`block truncate ${styles.snapshotMuted}`}>{code}</small>
                      </span>
                    </button>
                  </th>
                  <td className={`break-words py-2.5 pl-1 text-right ${styles.snapshotInk}`}>
                    {amount(decimal(position.value), 2)}<small className={`block ${styles.snapshotMuted}`}>{amount(decimal(position.quantity))}</small>
                  </td>
                  <td className={`break-words py-2.5 pl-1 text-right ${styles.snapshotInk}`}>
                    {amount(decimal(position.close?.value), 2)}<small className={`block ${styles.snapshotMuted}`}>{amount(decimal(position.cost), 2)}</small>
                  </td>
                  <td className={`break-words py-2.5 pl-1 text-right font-medium ${tone(profit)}`}>
                    {signed(profit, 2)}{percent !== null && <small className="block">{signed(percent, 2, "%")}</small>}
                  </td>
                </tr>
                {isExpanded && <tr><td colSpan={4} className="pb-3">
                  <div className={styles.snapshotHoldingActions}>
                    <button type="button" aria-label="查看持仓记录"
                      onClick={() => onOpen(position.recordId, typeof position.recordRevision === "number" ? position.recordRevision : undefined)}>
                      <IconFileDescription size={16} aria-hidden="true" />持仓记录
                    </button>
                    <button type="button" onClick={event => onProfit(position.recordId, event.currentTarget)}>
                      <IconArrowUpRight size={16} aria-hidden="true" />盈亏
                    </button>
                  </div>
                </td></tr>}
              </tbody>;
            })}
          </table>
        </details>;
      })}
    </section>
  );
}
