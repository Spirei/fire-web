import { useMarketBadge } from "@/lib/useMarketBadge";

interface Props {
  market: string;
  code: string;
  className?: string;
}

export default function MarketCodeBadge({ market, code, className = "" }: Props) {
  const badge = useMarketBadge(market, code);
  return (
    <span
      className={`inline-flex h-[18px] min-w-[30px] flex-none items-center justify-center rounded-[4px] px-1.5 text-[10px] font-bold leading-none tracking-[0.01em] ${className}`}
      style={{ backgroundColor: badge.bg, color: badge.fg }}
      aria-label={`${badge.label} 市场`}
    >
      {badge.label}
    </span>
  );
}
