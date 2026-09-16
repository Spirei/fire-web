import { relatedEtfBadge } from "@/lib/relatedEtfs";

/** 全站相关 ETF 角标：固定圆形、右下错位，完整类型保留在悬停说明。 */
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
      className={`absolute -bottom-2 -right-0.5 inline-flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full border-[1.5px] border-white bg-[#4b5563] p-0 text-[8px] font-bold leading-none tracking-[-0.04em] text-white shadow-[0_1px_4px_rgba(0,0,0,.28)] dark:border-[#161b25] ${className}`}
    >
      {badge.label}
    </span>
  );
}
