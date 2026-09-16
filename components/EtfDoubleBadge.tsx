import { relatedEtfBadge } from "@/lib/relatedEtfs";

/**
 * 相关 ETF 标记：跟 MarketCodeBadge 同一套「名称下方代码行里的小标签」，
 * 不再往股票 logo 上盖角标 —— 角标会压住图标、又跟主流行情软件的做法不一致
 * （雪球 / 富途 / 微牛都是把「2×做多」「反向」这类属性做成名称旁的小标签）。
 */
const TONES: Record<string, string> = {
  "2x": "bg-[#fdf0d9] text-[#9a5b06] dark:bg-[#f59e0b]/18 dark:text-[#fbbf24]",
  "多": "bg-[#fdecec] text-[#c0393f] dark:bg-[#e5484d]/20 dark:text-[#ff9a9d]",
  "反": "bg-[#e7f7f1] text-[#067a58] dark:bg-[#0aa77d]/20 dark:text-[#4fd1ab]",
  "收": "bg-[#eaf3fe] text-[#1d6fd0] dark:bg-[#3297f6]/20 dark:text-[#8ec5ff]"
};

/** 显示用写法：乘号比小写 x 更像倍率标记 */
const DISPLAY: Record<string, string> = { "2x": "2×" };

export default function EtfDoubleBadge({
  market,
  code,
  name,
  className = ""
}: {
  market: string;
  code: string;
  name?: string;
  className?: string;
}) {
  const badge = relatedEtfBadge(market, code, name);
  if (!badge) return null;
  const tone = TONES[badge.label] || TONES["2x"];
  return (
    <span
      title={badge.title}
      aria-label={badge.title}
      className={`inline-flex h-[18px] flex-none items-center justify-center rounded-[4px] px-1.5 text-[10px] font-bold leading-none tracking-[0.01em] ${tone} ${className}`}
    >
      {DISPLAY[badge.label] || badge.label}
    </span>
  );
}
