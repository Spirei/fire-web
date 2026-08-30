"use client";

import { useEffect, useRef, useState } from "react";
import { fmtNum, fmtPct, fmtQuoteTime } from "@/lib/format";
import type { GroupConfig, Market, Quote, RecordInput, SearchMatch, StockRecord } from "@/lib/types";
import { showToast } from "@/lib/toast";
import QuotesView from "@/components/views/QuotesView";
import MarketIcon from "@/components/MarketIcon";

interface Props {
  /** 个股详情直达代码（如 US.GOOGL），来自 /watchlist/US.GOOGL 路径 */
  initialSymbol?: string;
  records: StockRecord[];
  quotes: Record<string, Quote>;
  quoteAt: string;
  refreshing: boolean;
  refreshQuotes: () => void;
  onAddMatch: (match: SearchMatch) => Promise<boolean>;
  onUpdate: (id: string, input: RecordInput) => Promise<boolean>;
  onRemove: (r: StockRecord) => void;
  onBatchDelete: (ids: string[]) => Promise<boolean>;
  onToggleWatch: (r: StockRecord, follow: boolean) => Promise<boolean>;
  groups: GroupConfig[];
}

interface IndexQuote {
  name: string;
  open: number | null;
  latest: number | null;
  changePct: number | null;
  time: string;
  extra?: string;
}

interface MarketIndices {
  market: Market;
  label: string;
  flag: string;
  open: boolean;
  indices: IndexQuote[];
}

// CNN 恐惧与贪婪仪表盘（中文）
function FearGreedGauge({ score }: { score: number }) {
  const cx = 102;
  const cy = 95;
  const r = 62;
  const angle = (Math.min(100, Math.max(0, score)) / 100) * 180 - 90;
  const tick = (v: number) => {
    // 与弧段/标签同一角度系：0 在最左，100 在最右
    const a = ((v - 50) / 50) * 90 - 90;
    const rad = (a * Math.PI) / 180;
    const x1 = cx + Math.cos(rad) * (r + 8);
    const y1 = cy + Math.sin(rad) * (r + 8);
    const x2 = cx + Math.cos(rad) * (r + 16);
    const y2 = cy + Math.sin(rad) * (r + 16);
    return { x1, y1, x2, y2, tx: cx + Math.cos(rad) * (r + 26), ty: cy + Math.sin(rad) * (r + 26) };
  };
  const seg = (v0: number, v1: number, color: string) => {
    const a0 = ((v0 - 50) / 50) * 90; // -90..90
    const a1 = ((v1 - 50) / 50) * 90;
    const rad0 = ((a0 - 90) * Math.PI) / 180;
    const rad1 = ((a1 - 90) * Math.PI) / 180;
    const x0 = cx + Math.cos(rad0) * r;
    const y0 = cy + Math.sin(rad0) * r;
    const x1 = cx + Math.cos(rad1) * r;
    const y1 = cy + Math.sin(rad1) * r;
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return <path key={color} d={`M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`} stroke={color} strokeWidth="16" fill="none" strokeLinecap="butt" />;
  };
  // [位置, 文案, 水平偏移]：两端标签略微外移，避免与刻度线重叠
  const labels: [number, string, number][] = [
    [12.5, "极度恐惧", -3],
    [37.5, "恐惧", 0],
    [50, "中性", 0],
    [62.5, "贪婪", 0],
    [87.5, "极度贪婪", 3]
  ];
  return (
    <div className="w-full">
      <svg viewBox="0 0 204 106" className="mx-auto w-full max-w-[260px]">
        {/* 背景弧 */}
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} className="stroke-black/10 dark:stroke-white/10" strokeWidth="16" fill="none" strokeLinecap="butt" />
        {/* 五段情绪弧 */}
        {seg(0, 25, "#e23d3d")}
        {seg(25, 50, "#f5a623")}
        {seg(50, 50, "#f5c542")}
        {seg(50, 75, "#57c785")}
        {seg(75, 100, "#0fa07b")}
        {/* 主刻度 */}
        {[0, 25, 50, 75, 100].map((v) => {
          const t = tick(v);
          return (
            <g key={v}>
              <line x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} className="stroke-[#9aa1ab] dark:stroke-[#677183]" strokeWidth="1.5" />
              <text x={t.tx} y={t.ty + 3} textAnchor="middle" fontSize="9" className="fill-[#9aa1ab] dark:fill-[#677183]">{v}</text>
            </g>
          );
        })}
        {/* 中文情绪标签 */}
        {labels.map(([v, label, dx]) => {
          const a = ((v - 50) / 50) * 90 - 90;
          const rad = (a * Math.PI) / 180;
          return (
            <text
              key={label}
              x={cx + Math.cos(rad) * (r + 24) + dx}
              y={cy + Math.sin(rad) * (r + 24) + 10}
              textAnchor="middle"
              fontSize="8.5"
              className="fill-[#6b7280] dark:fill-[#99a3b2]"
            >
              {label}
            </text>
          );
        })}
        {/* 指针 */}
        <line x1={cx} y1={cy} x2={cx} y2={cy - r + 12} className="text-ink" stroke="currentColor" strokeWidth="3" strokeLinecap="round" transform={`rotate(${angle} ${cx} ${cy})`} />
        <circle cx={cx} cy={cy} r="5" className="text-ink" fill="currentColor" />
        <circle cx={cx} cy={cy} r="2" className="fill-white dark:fill-[#10141d]" />
      </svg>
    </div>
  );
}

export default function WatchlistView({ initialSymbol, records, quotes, quoteAt, refreshing, refreshQuotes, onAddMatch, onUpdate, onRemove, onBatchDelete, onToggleWatch, groups }: Props) {
  const [indexGroups, setIndexGroups] = useState<MarketIndices[]>([]);
  const [indicesLoading, setIndicesLoading] = useState(true);
  const [indicesError, setIndicesError] = useState("");
  // 刷新时若 URL 已带个股详情路径（/watchlist/US.GOOGL），首帧即隐藏指数卡片，避免闪现
  const [detailOpen, setDetailOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      /^[A-Za-z]{2,5}\.[A-Z0-9._-]+$/.test((window.location.pathname.split("/").filter(Boolean).pop() || ""))
  );
  const INDICES_CACHE_KEY = "fire:indices:cache";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // 先用本地缓存秒出指数卡片，再后台拉取最新数据
    try {
      const raw = localStorage.getItem(INDICES_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MarketIndices[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setIndexGroups(parsed);
          setIndicesLoading(false);
        }
      }
    } catch {
      /* 缓存无效忽略 */
    }
    const load = () => {
      setIndicesError("");
      fetch("/api/indices")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.groups) {
            setIndexGroups(data.groups);
            try {
              localStorage.setItem(INDICES_CACHE_KEY, JSON.stringify(data.groups));
            } catch {
              /* 存储失败忽略 */
            }
          }
        })
        .catch(() => {
          if (!cancelled && indexGroups.length === 0) setIndicesError("全球指数暂时不可用");
        })
        .finally(() => {
          if (!cancelled) setIndicesLoading(false);
        });
    };
    load();
    // 实时圆点：每分钟刷新一次开市状态与涨跌
    timer = setInterval(() => {
      if (!document.hidden) load();
    }, 60000);
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const dragIndex = useRef<number | null>(null);

  async function handleDropCard(to: number) {
    if (dragIndex.current === null) return;
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === to) return;
    const list = [...indexGroups];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    setIndexGroups(list);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indicesOrder: list.map((g) => g.market) })
      });
      if (!res.ok) throw new Error(`保存失败 ${res.status}`);
      showToast("指数卡片顺序已更新");
      window.dispatchEvent(new Event("fire:settings-updated"));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    }
  }

  return (
    <div>
      {/* 大盘指数卡片（个股详情打开时隐藏，避免详情页被指数区块挤压） */}
      {!detailOpen && (
        <div className="watchlist-index-grid mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {indicesLoading && indexGroups.length === 0 &&
            Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-[190px] animate-pulse rounded-[16px] border border-edge bg-bg-gray/70" />
            ))}
          {indicesError && indexGroups.length === 0 && (
            <div className="col-span-full flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-[16px] border border-edge bg-white text-center">
              <p className="text-sm font-semibold text-ink-2">{indicesError}</p>
              <p className="text-xs text-muted">页面其余功能仍可正常使用，稍后会自动重试</p>
            </div>
          )}
          {indexGroups.map((g, i) => {
          const fg = g.market === "F&G" ? g.indices[0] : null;
          const fgUp = (fg?.changePct ?? 0) >= 0;
          const fgBadge =
            fg?.extra === "极度恐惧" || fg?.extra === "恐惧"
              ? "bg-up-bg text-up"
              : fg?.extra === "极度贪婪" || fg?.extra === "贪婪"
                ? "bg-down-bg text-down"
                : "bg-bg-gray text-muted";
          return (
            <div
              key={g.market}
              draggable
              onDragStart={(e) => {
                dragIndex.current = i;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDropCard(i)}
              onDragEnd={() => {
                dragIndex.current = null;
              }}
              title="拖动排序"
              className="cursor-grab rounded-[16px] border border-edge bg-white p-5 shadow-card transition-shadow hover:shadow-pop active:cursor-grabbing"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-ink">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5 flex-none opacity-40">
                    <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                    <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                    <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                  </svg>
                  {g.market !== "F&G" && <MarketIcon market={g.market} flag={g.flag} size={18} />}
                  <span className="truncate">{g.label}</span>
                  {fg && fg.extra && (
                    <span className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-bold ${fgBadge}`}>{fg.extra}</span>
                  )}
                </span>
                {g.indices[0]?.time && (
                  <span className="flex flex-none items-center gap-1.5">
                    {g.indices[0]?.latest != null && (
                      <span
                        title={g.open ? "交易中" : "休市"}
                        className={`h-2 w-2 flex-none rounded-full ${
                          g.open
                            ? `live-dot ${(g.indices[0]?.changePct ?? 0) >= 0 ? "bg-up" : "bg-down"}`
                            : (g.indices[0]?.changePct ?? 0) >= 0
                              ? "bg-up/50"
                              : "bg-down/50"
                        }`}
                      />
                    )}
                    <span className="text-[11px] tabular-nums text-faint">{fmtQuoteTime(g.indices[0].time).slice(11)}</span>
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-2.5">
                {fg && fg.latest != null ? (
                  <div className="rounded-[12px] bg-white px-2 pt-2">
                    <FearGreedGauge score={fg.latest} />
                    {/* 指针下方一排：数值 / 涨跌幅 / 前收 */}
                    <div className="mt-0.5 flex items-baseline justify-center gap-3 rounded-[10px] bg-bg-gray px-3 py-1.5">
                      <b className={`text-lg font-extrabold tabular-nums ${fgUp ? "text-up" : "text-down"}`}>{fmtNum(fg.latest)}</b>
                      <span className={`text-xs font-bold tabular-nums ${fgUp ? "text-up" : "text-down"}`}>
                        {fgUp ? "+" : ""}
                        {fmtPct((fg.changePct ?? 0) / 100)}
                      </span>
                      <span className="text-[11px] text-faint">{fg.open != null ? `前收 ${fmtNum(fg.open)}` : "前收 —"}</span>
                    </div>
                  </div>
                ) : (
                  g.indices.map((idx) => {
                    const hasData = idx.latest !== null;
                    const up = (idx.changePct ?? 0) >= 0;
                    return (
                      <div key={idx.name} className="rounded-[12px] bg-bg-gray px-3.5 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-ink-2">{idx.name}</span>
                          {idx.extra && (
                            <span
                              className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                idx.extra === "极度恐惧" || idx.extra === "恐惧"
                                  ? "bg-up-bg text-up"
                                  : idx.extra === "极度贪婪" || idx.extra === "贪婪"
                                    ? "bg-down-bg text-down"
                                    : "bg-bg-gray text-muted"
                              }`}
                            >
                              {idx.extra}
                            </span>
                          )}
                          <span className={`flex-none text-xs font-bold tabular-nums ${hasData ? (up ? "text-up" : "text-down") : "text-faint"}`}>
                            {hasData ? `${up ? "+" : ""}${fmtPct((idx.changePct ?? 0) / 100)}` : "暂无数据"}
                          </span>
                        </div>
                        <div className="mt-1 flex items-baseline justify-between gap-2">
                          <b className={`text-[17px] font-extrabold tabular-nums ${hasData ? (up ? "text-up" : "text-down") : "text-faint"}`}>
                            {hasData ? fmtNum(idx.latest as number) : "—"}
                          </b>
                          <span className="text-[11px] text-faint">
                            {hasData ? `开盘 ${fmtNum(idx.open as number)}` : "开盘 —"}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
          })}
        </div>
      )}

      {/* 股票添加全部功能（搜索 / 行情板 / 刷新间隔 / 批量删除 / 编辑） */}
      <QuotesView
        initialSymbol={initialSymbol}
        records={records}
        quotes={quotes}
        quoteAt={quoteAt}
        refreshing={refreshing}
        refreshQuotes={refreshQuotes}
        onAddMatch={onAddMatch}
        onBatchDelete={onBatchDelete}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onToggleWatch={onToggleWatch}
        groups={groups}
        onDetailChange={setDetailOpen}
      />
    </div>
  );
}
