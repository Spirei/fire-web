import { isStockConnect } from "@/lib/stockAccount";

const title = "港股通 · A 股账户 · 港股上市、港币报价 · 人民币市值与浮动盈亏按当前汇率估值";

export default function StockConnectBadge({ market, accountMarket, variant = "mark" }: { market: string; accountMarket?: string; variant?: "mark" | "label" }) {
  if (!isStockConnect({ market, accountMarket })) return null;
  if (variant === "label") {
    return <span aria-label="港股通：A 股账户，港股上市" title={title} className="inline-flex shrink-0 items-center rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted dark:bg-white/10">港股通</span>;
  }
  return <span aria-label="A/H 港股通：A 股账户，港股上市" title={title} className="inline-flex shrink-0 rounded border border-edge bg-bg-gray px-1 py-0.5 text-[10px] font-semibold leading-none text-ink-2">A/H</span>;
}
