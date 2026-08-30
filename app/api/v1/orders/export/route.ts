import { getAuthUser } from "@/lib/auth";
import { fail } from "@/lib/api";
import { listOrders } from "@/lib/orders";
import { buildXlsx, type XlsxValue } from "@/lib/xlsx";
import { marketMeta } from "@/lib/types";

const CURRENCY_BY_MARKET: Record<string, string> = {
  US: "USD",
  HK: "HKD",
  CN: "CNY",
  JP: "JPY",
  KR: "KRW",
  SG: "SGD",
  UK: "GBP"
};
const MARKET_ZONE: Record<string, string> = {
  US: "美东",
  HK: "北京时间",
  CN: "北京时间",
  JP: "东京时间",
  KR: "首尔时间"
};
/** 当前系统按限价单记一笔完整成交：触发单 / 剩余挂单 / 撤单 / 驳回不适用 */
const EXPORT_HEADERS = [
  "订单状态", "市场", "股票代码", "股票名称", "方向", "委托类型", "委托数量", "委托价格", "触发价格", "币种",
  "委托时间", "成交均价", "成交数量", "成交金额", "剩余挂单数量", "撤/废单数量", "有效期", "时段", "触发状态", "订单号", "驳回原因"
];
const DETAIL_HEADERS = [
  "订单号", "订单状态", "市场", "股票代码", "股票名称", "方向", "委托类型", "委托数量", "委托价格", "币种",
  "委托时间", "成交均价", "成交数量", "成交金额", "费用", "已实现盈亏", "成交后持仓数量", "成交后持仓成本",
  "有效期", "时段", "触发状态", "驳回原因", "备注"
];

function formatOrderTime(iso: string, market: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const zone = MARKET_ZONE[(market || "").toUpperCase()];
  return zone ? `${text} ${zone}` : text;
}

function currencyCode(market: string): string {
  return CURRENCY_BY_MARKET[(market || "").toUpperCase()] ?? (marketMeta(market).code.replace(/[$¥₩]$/, "") || "—");
}

function localDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isEtfName(name: string): boolean {
  return /ETF|做多|杠杆/i.test(name);
}

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return fail(40101, "未登录", 401);
  const { searchParams } = new URL(request.url);
  const rawScope = searchParams.get("scope") || "all";
  const scope = rawScope === "today" || rawScope === "history" ? rawScope : "all";
  const market = String(searchParams.get("market") || "ALL").toUpperCase();
  const status = String(searchParams.get("status") || "all");
  const typeFilter = String(searchParams.get("type") || "all");
  const start = String(searchParams.get("start") || "").trim();
  const end = String(searchParams.get("end") || "").trim();
  const recordId = String(searchParams.get("recordId") || "").trim() || undefined;
  const limit = Math.min(10_000, Math.max(1, Number(searchParams.get("limit")) || 5_000));
  const withDetail = searchParams.get("detail") === "1";

  let orders = listOrders(user.id, scope, limit, recordId, market, status);
  if (typeFilter === "stock" || typeFilter === "etf") {
    orders = orders.filter((order) => typeFilter === "etf" ? isEtfName(order.name) : !isEtfName(order.name));
  }
  if (start) orders = orders.filter((order) => localDateKey(order.tradedAt) >= start);
  if (end) orders = orders.filter((order) => localDateKey(order.tradedAt) <= end);
  const rows: XlsxValue[][] = orders.map((order) => {
    const meta = marketMeta(order.market);
    return [
      order.status === "filled" ? "已成交" : "已撤销",
      meta.label,
      order.code,
      order.name,
      order.side === "buy" ? "买入" : "卖出",
      "限价单",
      order.qty,
      order.price,
      "—",
      currencyCode(order.market),
      formatOrderTime(order.tradedAt, order.market),
      order.price,
      order.qty,
      Math.round(order.amount * 100) / 100,
      0,
      0,
      "撤单前有效",
      "盘中+盘前盘后",
      "未触发",
      order.orderNo,
      "—"
    ];
  });

  const sheets: Parameters<typeof buildXlsx>[0] = [{
    name: "订单",
    headers: EXPORT_HEADERS,
    rows,
    colWidths: [10, 8, 14, 26, 6, 10, 10, 10, 10, 8, 26, 10, 10, 14, 12, 12, 12, 16, 10, 14, 12]
  }];
  if (withDetail) {
    sheets.push({
      name: "订单明细",
      headers: DETAIL_HEADERS,
      rows: orders.map((order) => {
        const meta = marketMeta(order.market);
        return [
          order.orderNo,
          order.status === "filled" ? "已成交" : "已撤销",
          meta.label,
          order.code,
          order.name,
          order.side === "buy" ? "买入" : "卖出",
          "限价单",
          order.qty,
          order.price,
          currencyCode(order.market),
          formatOrderTime(order.tradedAt, order.market),
          order.price,
          order.qty,
          Math.round(order.amount * 100) / 100,
          order.fees,
          order.realizedPnl == null ? "—" : Math.round(order.realizedPnl * 100) / 100,
          order.positionQtyAfter,
          order.positionCostAfter == null ? "—" : Math.round(order.positionCostAfter * 1000) / 1000,
          "撤单前有效",
          "盘中+盘前盘后",
          "未触发",
          "—",
          order.note || "—"
        ];
      }),
      colWidths: [14, 10, 8, 14, 26, 6, 10, 10, 10, 8, 26, 10, 10, 14, 10, 12, 14, 14, 12, 16, 10, 10, 20]
    });
  }
  const buf = buildXlsx(sheets);

  const today = new Date();
  const datePart = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const fileName = `订单导出-${scope === "today" ? "当日" : scope === "history" ? "历史" : "全部"}-${datePart}.xlsx`;
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store"
    }
  });
}
