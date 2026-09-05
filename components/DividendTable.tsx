"use client";

import type { DividendPhase, DividendRecord } from "@/lib/dividends";

export function yearOfDividend(item: DividendRecord) {
  return item.exDate?.slice(0, 4) ?? item.payDate?.slice(0, 4) ?? item.pubDate?.slice(0, 4) ?? item.fiscalYear ?? "未知";
}

export function fmtDividendAmount(item: DividendRecord) {
  if (item.amount == null) return "非现金";
  return `${item.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${item.currency || ""}`.trim();
}

export function fmtDividendYield(item: DividendRecord) {
  if (item.yieldPct == null || !Number.isFinite(item.yieldPct)) return "—";
  return `${item.yieldPct >= 10 ? item.yieldPct.toFixed(1) : item.yieldPct.toFixed(2)}%`;
}

export function shortDividendDate(value?: string | null) {
  if (!value) return "—";
  return value.slice(5);
}

export type DividendStatusTone = DividendPhase | "paid";

export default function DividendTable({
  rows,
  showYear,
  statusOf
}: {
  rows: DividendRecord[];
  showYear: boolean;
  statusOf: (item: DividendRecord) => { label: string; tone: DividendStatusTone };
}) {
  const sparse = rows.length <= 12;

  return (
    <div className={`div-table-wrap ${sparse ? "is-sparse" : ""}`}>
      <table className="div-table">
        <thead>
          <tr>
            {showYear && <th className="div-table-year">年份</th>}
            <th>每股</th>
            <th className="div-table-yield">股息率</th>
            <th>除息</th>
            <th className="div-table-pay">派付</th>
            <th className="div-table-status">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item, index) => {
            const year = yearOfDividend(item);
            const yearStart = showYear && (index === 0 || year !== yearOfDividend(rows[index - 1]));
            const status = statusOf(item);
            const tone = status.tone === "paid" ? "booked" : status.tone;
            return (
              <tr
                key={`${item.exDate || item.payDate || item.pubDate}-${index}`}
                className={`is-${tone}${yearStart ? " is-year-start" : ""}`}
                title={item.statement || undefined}
              >
                {showYear && <td className="div-table-year tabular-nums">{yearStart ? year : ""}</td>}
                <td className="div-table-amt">
                  <b className="tabular-nums">{fmtDividendAmount(item)}</b>
                  {item.kind === "special" && <i>特别</i>}
                </td>
                <td className="div-table-yield tabular-nums">{fmtDividendYield(item)}</td>
                <td className="tabular-nums text-muted">{shortDividendDate(item.exDate)}</td>
                <td className="div-table-pay tabular-nums text-muted">{shortDividendDate(item.payDate)}</td>
                <td className="div-table-status"><em>{status.label}</em></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
