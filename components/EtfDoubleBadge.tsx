import { relatedEtfBadge, type RelatedEtfBadgeTone } from "@/lib/relatedEtfs";

/** 全站相关 ETF 角标：固定圆形、右下错位，完整类型保留在悬停说明。 */
const TONE: Record<RelatedEtfBadgeTone, string> = {
  long2x: "bg-[#ff4d78] shadow-[0_1px_4px_rgba(255,77,120,.36)]",
  short: "bg-[#12c48b] shadow-[0_1px_4px_rgba(18,196,139,.36)]",
  income: "bg-[#e8890c] shadow-[0_1px_4px_rgba(232,137,12,.36)]",
  long: "bg-[#3b93ff] shadow-[0_1px_4px_rgba(59,147,255,.36)]"
};

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
  return (
    <span
      title={badge.title}
      aria-label={badge.title}
      className={`absolute -bottom-2 -right-0.5 inline-flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full border-[1.5px] border-white p-0 text-[8px] font-bold leading-none tracking-[-0.04em] text-white dark:border-[#161b25] ${TONE[badge.tone]} ${className}`}
    >
      {badge.label}
    </span>
  );
}
