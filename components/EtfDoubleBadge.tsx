"use client";

import { useMarketBadge } from "@/lib/useMarketBadge";

/** 2 倍杠杆 ETF 角标：颜色与市场色块一致（US 蓝 / HK 紫 / A股 粉红），文字固定 2x（x 小写） */
export default function EtfDoubleBadge({
  market,
  code,
  className = ""
}: {
  market: string;
  code: string;
  className?: string;
}) {
  const b = useMarketBadge(market, code);
  return (
    <span
      className={`inline-flex flex-none items-center justify-center rounded-full px-[5px] py-[2px] text-[9px] font-bold leading-none ring-[1.5px] ring-white shadow-[0_1px_3px_rgba(0,0,0,.18)] ${className}`}
      style={{ backgroundColor: b.bg, color: b.fg }}
    >
      2x
    </span>
  );
}
