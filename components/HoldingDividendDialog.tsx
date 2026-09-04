"use client";

import { useEffect, useMemo, useState } from "react";
import AppModal from "@/components/AppModal";
import type { DividendLedgerRow, DividendPhase, DividendRecord } from "@/lib/dividends";
import type { StockRecord } from "@/lib/types";
import { showToast } from "@/lib/toast";

function yearOf(item: DividendRecord) {
  return item.exDate?.slice(0, 4) ?? item.payDate?.slice(0, 4) ?? item.pubDate?.slice(0, 4) ?? item.fiscalYear ?? "未知";
}

function fmtAmount(item: DividendRecord) {
  if (item.amount == null) return "非现金";
  return `${item.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${item.currency || ""}`.trim();
}

function fmtYield(item: DividendRecord) {
  if (item.yieldPct == null || !Number.isFinite(item.yieldPct)) return "—";
  return `${item.yieldPct >= 10 ? item.yieldPct.toFixed(1) : item.yieldPct.toFixed(2)}%`;
}

function shortDate(value?: string | null) {
  if (!value) return "—";
  return value.slice(5);
}

const PHASE_LABEL: Record<DividendPhase, string> = {
  booked: "已入账",
  missing: "未入账",
  pending: "待派发",
  before: "买入前",
  unowned: "当时未持仓",
  info: "已披露"
};

function ledgerKey(row: Pick<DividendLedgerRow, "exDate" | "payDate">) {
  return `${row.exDate || ""}|${row.payDate || ""}`;
}

export default function HoldingDividendDialog({
  record,
  onClose,
  onSettled
}: {
  record: StockRecord;
  onClose: () => void;
  onSettled?: () => void;
}) {
  const [dividends, setDividends] = useState<DividendRecord[]>([]);
  const [ledger, setLedger] = useState<DividendLedgerRow[]>([]);
  const [firstBuy, setFirstBuy] = useState<string | null>(null);
  const [sourceOk, setSourceOk] = useState(true);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/dividends?market=${encodeURIComponent(record.market)}&code=${encodeURIComponent(record.code)}&recordId=${encodeURIComponent(record.id)}`);
      const json = await res.json().catch(() => null);
      setSourceOk(json?.data?.source !== "unavailable");
      setDividends(Array.isArray(json?.data?.dividends) ? json.data.dividends : []);
      setLedger(Array.isArray(json?.data?.holding?.rows) ? json.data.holding.rows : []);
      setFirstBuy(json?.data?.holding?.firstBuyDate || null);
    } catch {
      setSourceOk(false);
      setDividends([]);
      setLedger([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.market, record.code]);

  const statusByKey = useMemo(() => {
    const map = new Map<string, DividendLedgerRow>();
    ledger.forEach((row) => map.set(ledgerKey(row), row));
    return map;
  }, [ledger]);

  function statusOf(item: DividendRecord) {
    return statusByKey.get(ledgerKey({ exDate: item.exDate, payDate: item.payDate }));
  }

  const years = useMemo(() => [...new Set(dividends.map(yearOf))].sort((a, b) => b.localeCompare(a)), [dividends]);
  const visible = year ? dividends.filter((item) => yearOf(item) === year) : dividends;
  const cash = dividends.filter((item) => item.kind === "cash" && Number(item.amount) > 0);
  const latestOwned = cash.find((item) => {
    const row = statusOf(item);
    return row && row.phase !== "before";
  }) || cash[0];
  const missing = ledger.filter((row) => row.phase === "missing").length;
  const booked = ledger.filter((row) => row.phase === "booked").length;
  const yearCash = visible.filter((item) => item.kind === "cash" && Number(item.amount) > 0);
  const yearCurrencies = [...new Set(yearCash.map((item) => item.currency).filter(Boolean))];
  const yearTotal = yearCurrencies.length <= 1
    ? yearCash.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
    : null;
  const grouped = year
    ? [[year, visible] as const]
    : years.map((label) => [label, dividends.filter((item) => yearOf(item) === label)] as const);

  async function settleMissing() {
    if (settling) return;
    setSettling(true);
    try {
      const res = await fetch("/api/v1/dividends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: record.id })
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(json?.message || "补录失败", "err");
        return;
      }
      const created = Number(json?.data?.created) || 0;
      showToast(created ? `已补录 ${created} 期股息到订单` : firstBuy ? "买入后没有待补录的股息" : "请先记录买入，买入前的派息不会入账");
      await load();
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:orders-updated"));
      onSettled?.();
    } catch {
      showToast("补录失败", "err");
    } finally {
      setSettling(false);
    }
  }

  return (
    <AppModal
      title={`${record.name} 股息`}
      desc={firstBuy ? `${record.code} · 自 ${firstBuy} 首次买入后入账` : `${record.code} · 尚未记录买入，历史派息不会入账`}
      size="lg"
      onClose={onClose}
      headerActions={
        <button type="button" disabled={settling || !firstBuy} onClick={() => void settleMissing()} className="btn-line h-9 shrink-0 px-3 text-xs disabled:opacity-50">
          {settling ? "补录中…" : missing ? `补充缺失 ${missing}` : "同步入账"}
        </button>
      }
    >
      {loading ? (
        <div className="flex min-h-[240px] items-center justify-center text-sm text-muted">正在获取历年股息…</div>
      ) : !sourceOk ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-1 text-center text-sm text-muted">股息数据源暂时不可用<small className="text-xs text-faint">稍后重试，不影响持仓与订单</small></div>
      ) : dividends.length === 0 ? (
        <div className="flex min-h-[240px] items-center justify-center text-sm text-muted">暂无已披露的股息记录</div>
      ) : (
        <div className="holding-div">
          <div className="stock-dividend-summary">
            <div><span>最近每股</span><b>{latestOwned?.amount != null ? fmtAmount(latestOwned) : "—"}</b><small>{latestOwned?.exDate ? `除息 ${latestOwned.exDate}` : "暂无除息日"}</small></div>
            <div><span>{year || "披露"}累计</span><b>{yearTotal != null ? `${yearTotal.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${yearCurrencies[0] || ""}` : "多币种"}</b><small>{yearCash.length} 次现金</small></div>
            <div><span>订单入账</span><b>{booked} 期</b><small>{missing ? `${missing} 期待补录` : firstBuy ? "已按买入后对齐" : "需先有买入订单"}</small></div>
          </div>
          <div className="mb-3 flex gap-1.5 overflow-x-auto pb-0.5">
            {["全部", ...years].map((item) => {
              const active = item === "全部" ? year === null : year === item;
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => setYear(item === "全部" ? null : item)}
                  className={`flex-none rounded-full border px-3 py-1.5 text-[11px] font-semibold transition ${active ? "border-edge-strong bg-white text-ink shadow-sm dark:bg-[#1c1c1e] dark:text-white" : "border-edge text-muted hover:bg-bg-gray hover:text-ink"}`}
                >
                  {item === "全部" ? "全部" : item}
                </button>
              );
            })}
          </div>
          <div className="max-h-[min(440px,54vh)] space-y-3 overflow-y-auto pr-0.5">
            {grouped.map(([label, rows]) => (
              <section key={label} className="holding-div-year">
                {year === null && (
                  <header className="holding-div-year-head">
                    <b>{label}</b>
                    <small>{rows.length} 期</small>
                  </header>
                )}
                <div className="holding-div-table">
                  <div className="holding-div-head">
                    <span>每股</span><span>股息率</span><span>除息</span><span>派付</span><span>状态</span>
                  </div>
                  {rows.map((item, index) => {
                    const row = statusOf(item);
                    const phase = row?.phase || "info";
                    return (
                      <div key={`${item.exDate || item.payDate || item.pubDate}-${index}`} className={`holding-div-row is-${phase}`}>
                        <b className="tabular-nums">{fmtAmount(item)}</b>
                        <span className="holding-div-yield tabular-nums">{fmtYield(item)}</span>
                        <span className="tabular-nums">{shortDate(item.exDate)}</span>
                        <span className="tabular-nums">{shortDate(item.payDate)}</span>
                        <em>{PHASE_LABEL[phase]}</em>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </AppModal>
  );
}
