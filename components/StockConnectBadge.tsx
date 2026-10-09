import { isStockConnect } from "@/lib/stockAccount";

export default function StockConnectBadge({ market, accountMarket }: { market: string; accountMarket?: string }) {
  return isStockConnect({ market, accountMarket }) ? <span title="A 股账户 · 港币报价 · 人民币市值与浮动盈亏按当前汇率估值" className="inline-flex shrink-0 rounded border border-edge bg-bg-gray px-1 py-0.5 text-[10px] font-semibold leading-none text-ink-2">港股通</span> : null;
}
