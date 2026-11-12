"use client";

import type { Quote, StockRecord } from "@/lib/types";
import { hasLiveQuotes } from "@/lib/liveQuoteMarkets";

/** Extended availability follows observed session fields, never provider name alone. */
export default function QuoteSourceBadge({
  records,
  quotes
}: {
  records: StockRecord[];
  quotes: Record<string, Quote>;
}) {
  const extendedAlive = records.some((record) => {
    if (record.market !== "US") return false;
    const source = quotes[record.id]?.source;
    return source != null && ["PRE","AFTER","OVERNIGHT"].includes(quotes[record.id]?.session ?? "");
  });
  // 富途或 Yahoo 扩展行情还在时，剩下的腾讯美股是单只 OTC，交给行内标记。
  if (extendedAlive) return null;
  const tencentRows = records.filter(
    (record) => record.market === "US" && quotes[record.id]?.source === "tencent"
  );
  const fallback = tencentRows.some((record) => Number(record.qty) > 0) || tencentRows.length >= 2;
  const waiting=records.some(record=>record.market==="US" && quotes[record.id]?.extendedUnavailable===true);
  if (!fallback && !waiting) return null;
  return (
    <span
      title={fallback ? "腾讯仅提供常规盘报价，当前尚无有效扩展时段报价。" : "当前仅取得常规盘报价，扩展时段报价尚未就绪。"}
      className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
        <path d="M12 3.6 2.8 19.4a1.2 1.2 0 0 0 1.04 1.8h16.32a1.2 1.2 0 0 0 1.04-1.8L12 3.6Z" />
        <path d="M12 9.5v5" />
        <path d="M12 17.6h.01" />
      </svg>
      {fallback ? "美股·腾讯兜底" : "美股·扩展报价待更新"}
    </span>
  );
}

const hintClass =
  "inline-flex shrink-0 items-center rounded-full border border-amber-300/80 bg-amber-50 px-1.5 py-px text-[10px] font-medium leading-4 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300";

function hasExtendedQuotes(quotes: Record<string, Quote>): boolean {
  return Object.values(quotes).some((item) => ["PRE","AFTER","OVERNIGHT"].includes(item.session ?? ""));
}

/** 行内提示：无实时源的市场，或富途/Yahoo 不覆盖的单只 OTC。 */
export function QuoteRowHint({
  market,
  quote,
  quotes,
  className = ""
}: {
  market: string;
  quote?: Quote;
  quotes: Record<string, Quote>;
  className?: string;
}) {
  if (!hasLiveQuotes(market)) {
    return (
      <span className={`${hintClass} ${className}`} title="该市场暂无可用实时行情源（腾讯 / 富途均不覆盖），最新价与当日盈亏需要有效行情。">
        暂无实时行情
      </span>
    );
  }
  if (market.toUpperCase() !== "US" || quote?.source !== "tencent") return null;
  if (!hasExtendedQuotes(quotes)) return null;
  return (
    <span className={`${hintClass} ${className}`} title="该标的当前仅取得腾讯常规时段行情，未取得扩展时段报价；盘前、盘后及夜盘可能仍显示常规时段收盘值。">
      无扩展行情
    </span>
  );
}
