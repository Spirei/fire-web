import { useId } from "react";
import { formatOrderTime } from "@/lib/orderTime";
import type { TradeOrder } from "@/lib/types";

const statusLabels: Record<string, string> = {
  submitted: "已委托",
  pending: "已委托",
  amended: "已修改",
  filled: "已成交",
  cancelled: "已撤销",
  expired: "已过期",
  deleted: "已删除",
  merged: "已合并",
  imported_suspended: "已暂停",
};

function number(value: number | null, min = 0) {
  return value !== null && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { minimumFractionDigits: min, maximumFractionDigits: 8 })
    : "—";
}

export default function OrderHistory({ order }: { order: TradeOrder }) {
  const titleId = useId();
  const activity = order.orderActivity;
  const latestTimestamp = order.status === "pending" ? order.createdAt : order.status === "filled" ? order.tradedAt : null;
  const entries = activity?.length ? activity : [{
    id: order.id, timestamp: latestTimestamp, kind: order.status, quantity: order.qty, price: order.price,
  }];
  return (
    <section className="mt-5 border-t border-edge pt-4" aria-labelledby={titleId}>
      <h4 id={titleId} className="mb-2 text-sm font-semibold text-ink">订单历史</h4>
      <table className="w-full table-fixed text-xs">
        <thead className="text-muted">
          <tr>
            <th scope="col" className="w-[46%] pb-2 text-left font-medium">时间</th>
            <th scope="col" className="w-[29%] pb-2 text-right font-medium">数量 / 价格</th>
            <th scope="col" className="pb-2 text-right font-medium">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {entries.map(event => {
            const time = event.timestamp ? formatOrderTime(event.timestamp, order.market) : "—";
            const split = time.indexOf(" ");
            const label = statusLabels[event.kind] ?? "状态未知";
            return <tr key={event.id} className="align-top tabular-nums">
              <td className="py-2.5 pr-2 text-ink">
                {event.timestamp ? <time dateTime={event.timestamp}>
                  <span className="block font-medium">{split < 0 ? time : time.slice(0, split)}</span>
                  {split >= 0 && <span className="mt-0.5 block text-muted">{time.slice(split + 1)}</span>}
                </time> : "—"}
                {"tradeTime" in event && event.tradeTime && <span className="mt-0.5 block text-muted">
                  成交于 {formatOrderTime(event.tradeTime, order.market)}
                </span>}
              </td>
              <td className="break-words py-2.5 text-right">
                <span className="block font-medium text-ink">{number(event.quantity)}</span>
                <span className="mt-0.5 block text-muted">{number(event.price, 4)}</span>
              </td>
              <td className={`py-2.5 pl-2 text-right font-medium ${event.kind === "filled" ? "text-ink"
                : event.kind === "submitted" || event.kind === "pending" || event.kind === "amended" ? "text-brand-deep" : "text-muted"}`}>{label}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </section>
  );
}
