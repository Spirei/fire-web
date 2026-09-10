"use client";

import type { Quote, StockRecord } from "@/lib/types";

/**
 * 美股行情降级提示：当持仓里的美股拿不到富途行情、退回腾讯常规盘时显示。
 *
 * 腾讯对美股只提供常规盘口径（盘前 / 盘后 / 夜盘仍停在上一交易日收盘的涨跌），
 * 此时「当日盈亏 / 最新价 / 涨跌幅」都不会随盘前盘后变动，用户很难分辨是行情源
 * 降级还是数据本身没变，因此这里给一个琥珀色提示；富途正常时组件不渲染。
 *
 * 两种判定：有持仓的美股降级（当日盈亏会失真）必报；只看自选股时，至少两只走
 * 腾讯兜底才报 —— 富途对美股 OTC（如软银 ADR）本就不提供行情，单只 OTC 不该报警。
 */
export default function QuoteSourceBadge({
  records,
  quotes
}: {
  records: StockRecord[];
  quotes: Record<string, Quote>;
}) {
  const tencentRows = records.filter(
    (record) => record.market === "US" && quotes[record.id]?.source === "tencent"
  );
  const fallback = tencentRows.some((record) => Number(record.qty) > 0) || tencentRows.length >= 2;
  if (!fallback) return null;
  return (
    <span
      title="美股行情当前走腾讯兜底（富途 OpenD 未返回该批次行情）：盘前 / 盘后 / 夜盘的最新价与当日盈亏可能停留在上一交易日收盘，稍后会自动重试。"
      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
        <path d="M12 3.6 2.8 19.4a1.2 1.2 0 0 0 1.04 1.8h16.32a1.2 1.2 0 0 0 1.04-1.8L12 3.6Z" />
        <path d="M12 9.5v5" />
        <path d="M12 17.6h.01" />
      </svg>
      美股·腾讯兜底
    </span>
  );
}
