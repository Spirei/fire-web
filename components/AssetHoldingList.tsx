"use client";

import { useState, type ReactNode } from "react";
import AppModal from "./AppModal";
import { HOLDING_COLUMN_LABELS, type HoldingColumnKey } from "@/lib/holdingColumns";
import { marketMeta, type StockRecord } from "@/lib/types";

type Action = "buy" | "sell" | "close" | "dividend";

/** 手机持仓指标与桌面表格共用 cell，不重复计算金额。 */
export default function AssetHoldingList({ records, columns, cell, currency, sort, onSort, onAction }: {
  records: StockRecord[];
  columns: HoldingColumnKey[];
  cell: (record: StockRecord, key: HoldingColumnKey) => ReactNode;
  currency: string;
  sort: { key: HoldingColumnKey; dir: "asc" | "desc" } | null;
  onSort: (key: HoldingColumnKey | null) => void;
  onAction: (record: StockRecord, action: Action) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionRecord, setActionRecord] = useState<StockRecord | null>(null);
  const numericColumns: HoldingColumnKey[] = columns.filter(key => key !== "identity");
  const featured = ["marketValue", "pnl", ...numericColumns].filter((key, index, all) => numericColumns.includes(key as HoldingColumnKey) && all.indexOf(key) === index).slice(0, 2) as HoldingColumnKey[];
  const columnLabel = (record: StockRecord, key: HoldingColumnKey) => `${HOLDING_COLUMN_LABELS[key]}${key === "price" || key === "cost" ? ` · ${marketMeta(record.market).code}` : ""}`;
  return <div className="asset-mobile-holdings">
    <div className="asset-mobile-list-caption"><span>金额 · {currency}</span><div className="asset-mobile-sort">
      <select aria-label="持仓排序指标" value={sort?.key || ""} onChange={event => onSort((event.target.value || null) as HoldingColumnKey | null)}><option value="">默认排序</option>{sort && !columns.includes(sort.key) && <option value={sort.key}>{HOLDING_COLUMN_LABELS[sort.key]}</option>}{columns.map(key => <option key={key} value={key}>{HOLDING_COLUMN_LABELS[key]}</option>)}</select>
      {sort && <button type="button" onClick={() => onSort(sort.key)} aria-label={sort.dir === "desc" ? "切换为升序" : "切换为降序"}>{sort.dir === "desc" ? "↓" : "↑"}</button>}
    </div></div>
    {records.map(record => {
      const open = expanded === record.id;
      const panelId = `asset-holding-${record.id}`;
      return <article key={record.id} className="asset-mobile-holding">
        <button type="button" className="asset-mobile-holding-trigger" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setExpanded(open ? null : record.id)}>
          <span className="asset-mobile-holding-identity">{cell(record, "identity")}</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}/></svg>
          <span className="asset-mobile-holding-summary">{featured.map(key => <span key={key}><span>{columnLabel(record, key)}</span><strong>{cell(record, key)}</strong></span>)}</span>
        </button>
        {open && <div id={panelId} className="asset-mobile-holding-expanded">
          <dl>{numericColumns.filter(key => !featured.includes(key)).map(key => <div key={key}><dt>{columnLabel(record, key)}</dt><dd>{cell(record, key)}</dd></div>)}</dl>
          <button type="button" className="asset-mobile-trade-button" onClick={() => setActionRecord(record)}>交易</button>
        </div>}
      </article>;
    })}
    {actionRecord && <AppModal title={actionRecord.name} size="sm" className="asset-mobile-actions" onClose={() => setActionRecord(null)}>
      <div className="asset-mobile-action-list">{([['buy', '买入'], ['sell', '卖出'], ['close', '平仓'], ['dividend', '股息']] as const).map(([action, label]) => <button key={action} type="button" onClick={() => { setActionRecord(null); onAction(actionRecord, action); }}>{label}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>)}</div>
    </AppModal>}
  </div>;
}
