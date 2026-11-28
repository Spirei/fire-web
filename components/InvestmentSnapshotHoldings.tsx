"use client";

import { useEffect, useMemo, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import MarketIcon from "@/components/MarketIcon";
import SafeAssetImage from "@/components/SafeAssetImage";
import { MARKET_CURRENCY } from "@/lib/currency";
import { marketMeta } from "@/lib/types";
import { ensureStockIcons, useAssetIcons } from "@/lib/useAssetIcons";

type Data = Record<string, unknown>;
type Position = Data & { recordId: string; close: Data | null };

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

const tone = (value: number | null) => value === null || value === 0 ? "text-ink" : value > 0 ? "text-up" : "text-down";

export default function InvestmentSnapshotHoldings({ positions, calendar, onOpen }: {
  positions: Position[];
  calendar?: { rows?: Data[] } | null;
  onOpen: (id: string, revision?: number) => void;
}) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const [expanded, setExpanded] = useState<string | null>(null);
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

  if (!positions.length) return <p className="px-2 py-6 text-sm text-muted">本版快照没有持仓记录</p>;
  return (
    <div className="space-y-3" aria-label="日终持仓分布">
      {[...markets].map(([market, rows]) => {
        const currency = MARKET_CURRENCY[market] ?? "";
        const values = rows.map(row => row.close?.currency === currency || decimal(row.value) === 0 ? decimal(row.value) : null);
        const marketValue = values.every(value => value !== null)
          ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
        return <details key={market} open className="group rounded-xl border border-edge bg-white">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 font-semibold text-ink [&::-webkit-details-marker]:hidden">
            <IconChevronRight size={15} aria-hidden="true" className="text-muted group-open:rotate-90" />
            <MarketIcon market={market} size={20} />
            <span>{marketMeta(market).label}</span>
            <span className="ml-auto text-right text-xs tabular-nums">市值 {amount(marketValue, 2)}{marketValue === null || !currency ? "" : ` ${currency}`}</span>
          </summary>
          <table className="w-full table-fixed border-t border-edge text-xs tabular-nums" aria-label={`${marketMeta(market).label}持仓`}>
            <thead className="text-[11px] text-muted">
              <tr>
                <th scope="col" className="w-[34%] py-2 pl-2 text-left font-medium sm:pl-3">名称 / 代码</th>
                <th scope="col" className="w-[22%] py-2 pl-1 text-right font-medium">市值 / 数量</th>
                <th scope="col" className="w-[22%] py-2 pl-1 text-right font-medium">收盘 / 成本</th>
                <th scope="col" className="py-2 pl-1 pr-2 text-right font-medium sm:pr-3">日终盈亏</th>
              </tr>
            </thead>
            {rows.map(position => {
              const name = String(position.name || position.code || "—");
              const code = String(position.code || "—");
              const row = daily.get(position.recordId);
              const profit = row?.currency === currency ? decimal(row?.profit) : null;
              const capital = decimal(row?.capital);
              const percent = profit !== null && capital !== null && capital > 0 ? profit / capital * 100 : null;
              const isExpanded = expanded === position.recordId;
              return <tbody key={position.recordId} className="border-t border-edge">
                <tr className="align-middle">
                  <th scope="row" className="py-2.5 pl-2 text-left font-medium sm:pl-3">
                    <button type="button" className="flex w-full min-w-0 items-center gap-1.5 text-left sm:gap-2"
                      aria-expanded={isExpanded} onClick={() => setExpanded(isExpanded ? null : position.recordId)}>
                      <SafeAssetImage src={stockIcons[`${market}:${code.toUpperCase()}`]} className="hidden h-6 w-6 flex-none rounded-full sm:block"
                        fallback={<span className="grid h-6 w-6 place-items-center bg-bg-gray text-[10px] text-muted">{name.slice(0, 1)}</span>} loading="lazy" />
                      <span className="min-w-0">
                        <span className="block truncate text-ink" title={name}>{name}</span>
                        <small className="block truncate text-muted">{code}</small>
                      </span>
                    </button>
                  </th>
                  <td className="break-words py-2.5 pl-1 text-right text-ink">
                    {amount(decimal(position.value), 2)}<small className="block text-muted">{amount(decimal(position.quantity))}</small>
                  </td>
                  <td className="break-words py-2.5 pl-1 text-right text-ink">
                    {amount(decimal(position.close?.value), 2)}<small className="block text-muted">{amount(decimal(position.cost), 2)}</small>
                  </td>
                  <td className={`break-words py-2.5 pl-1 pr-2 text-right font-medium sm:pr-3 ${tone(profit)}`}>
                    {signed(profit, 2)}{percent !== null && <small className="block">{signed(percent, 2, "%")}</small>}
                  </td>
                </tr>
                {isExpanded && <tr><td colSpan={4} className="px-3 pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-gray px-3 py-2 text-muted">
                    {position.close && <span>收盘价 {String(position.close.tradeDay ?? "—")} · {String(position.close.source ?? "—")}</span>}
                    <button type="button" className="font-semibold text-brand-deep"
                      onClick={() => onOpen(position.recordId, typeof position.recordRevision === "number" ? position.recordRevision : undefined)}>查看持仓记录</button>
                  </div>
                </td></tr>}
              </tbody>;
            })}
          </table>
        </details>;
      })}
    </div>
  );
}
