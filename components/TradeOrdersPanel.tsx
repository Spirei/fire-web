"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtMoney, fmtPrice, fmtQty } from "@/lib/format";
import { marketMeta, type TradeOrder } from "@/lib/types";
import MarketIcon from "@/components/MarketIcon";
import { showToast } from "@/lib/toast";
import { usePersistedState } from "@/lib/usePersistedState";
import { FlatCheckbox } from "@/components/HoldingColumnManager";
import RefreshButton from "@/components/RefreshButton";
import DeleteIcon from "@/components/DeleteIcon";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import { appConfirm } from "@/lib/appDialog";

type OrderTab = "today" | "history";
type StatusFilter = "all" | "filled" | "pending" | "cancelled" | "expired";

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
const ORDER_TYPE_LABEL: Record<string, string> = {
  market: "市价单",
  limit: "限价单",
  trigger_buy: "到价买入",
  trigger_sell: "到价卖出",
  rebound_buy: "反弹买入",
  rebound_sell: "回落卖出"
};
const VALIDITY_LABEL: Record<string, string> = { day: "当日有效", gtc: "撤单前有效", custom: "自定义有效期" };
const STATUS_LABEL: Record<string, string> = { filled: "已成交", pending: "待成交", cancelled: "已撤销", expired: "已失效" };
function orderTypeLabel(order: TradeOrder): string {
  if (order.side === "dividend") return "股息入账";
  return ORDER_TYPE_LABEL[order.orderType] ?? "限价单";
}
function validityLabel(order: TradeOrder): string {
  if (order.side === "dividend") return "—";
  return VALIDITY_LABEL[order.tif] ?? "当日有效";
}

type OrderColumnKey =
  | "actions" | "status" | "market" | "code" | "name" | "side" | "orderType"
  | "qty" | "price" | "triggerPrice" | "currency" | "tradedAt" | "avgPrice"
  | "filledQty" | "amount" | "remainingQty" | "cancelledQty"
  | "validity" | "session" | "triggerStatus" | "orderNo" | "rejectReason";

interface OrderColumnDef {
  key: OrderColumnKey;
  label: string;
  align: "left" | "center" | "right";
  defaultVisible: boolean;
  sortable: boolean;
  minWidth: number;
}

interface OrderColumnPref {
  key: OrderColumnKey;
  visible: boolean;
}

interface OrderSort {
  key: OrderColumnKey;
  dir: "asc" | "desc";
}

interface ExportRecord {
  id: string;
  range: string;
  status: "成功";
  fileName: string;
  time: string;
  size: string;
  url: string;
}

interface ImportGroupResult {
  market: string;
  code: string;
  name: string;
  recordName: string | null;
  createdRecord: boolean;
  orderCount: number;
  finalQty: number;
  action: "imported" | "skipped" | "option";
  reason?: string;
}

interface ImportResultData {
  dryRun: boolean;
  fileName: string;
  totalFilled: number;
  imported: number;
  skipped: number;
  duplicated: number;
  groups: ImportGroupResult[];
}

const EXPORT_HISTORY_KEY = "fire:orders:export-history:v1";
const TIME_POPOVER_KEY = "fire:orders:time-popover:v1";
/** 订单列设置全局共享（资产分析 / 我的持仓详情两处一致，勾选即自动保存并全站生效） */
const ORDER_COLUMNS_KEY = "fire:orders:columns:v2";

interface TimePopoverConfig {
  width: number;
  height: number | null;
  dx: number;
  dy: number;
}

function loadTimePopover(): TimePopoverConfig | null {
  try {
    const raw = JSON.parse(localStorage.getItem(TIME_POPOVER_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const width = Number.isFinite(raw.width) ? Math.max(360, Math.min(raw.width, window.innerWidth - 16)) : 680;
    const height = raw.height == null ? null : Number.isFinite(raw.height) ? Math.max(260, Math.min(raw.height, window.innerHeight - 16)) : null;
    const dx = Number.isFinite(raw.dx) ? raw.dx : 0;
    const dy = Number.isFinite(raw.dy) ? raw.dy : 0;
    return { width, height, dx, dy };
  } catch {
    return null;
  }
}

type OrderTypeFilter = "all" | "stock" | "etf";
interface TimeFilterState {
  mode: "all" | "today" | "7d" | "30d" | "1y" | "custom";
  start: string;
  end: string;
}
const DEFAULT_TIME_FILTER: TimeFilterState = { mode: "all", start: "", end: "" };

function orderTypeOf(order: TradeOrder): "stock" | "etf" {
  return /ETF|做多|杠杆/i.test(order.name) ? "etf" : "stock";
}

function localIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localIso(date);
}

function timeRangeFor(mode: TimeFilterState["mode"]): { start: string; end: string } {
  const today = localIso(new Date());
  if (mode === "today") return { start: today, end: today };
  if (mode === "7d") return { start: shiftDays(today, -6), end: today };
  if (mode === "30d") return { start: shiftDays(today, -29), end: today };
  if (mode === "1y") return { start: shiftDays(today, -364), end: today };
  return { start: "", end: "" };
}

function timeDisplay(filter: TimeFilterState): string {
  if (filter.mode === "all") return "委托时间";
  if (filter.mode === "custom" && filter.start && filter.end) {
    return `委托时间:${filter.start.slice(5).replace("-", "/")}–${filter.end.slice(5).replace("-", "/")}`;
  }
  const label = filter.mode === "today" ? "当日" : filter.mode === "7d" ? "近7天" : filter.mode === "30d" ? "近30天" : "近1年";
  return `委托时间:${label}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
function shiftMonth(value: Date, delta: number) {
  return new Date(value.getFullYear(), value.getMonth() + delta, 1);
}

function loadExportHistory(): ExportRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPORT_HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((item): item is ExportRecord => !!item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

/** 复制文本：优先 Clipboard API（安全上下文），失败回退 execCommand，兼容局域网 IP 等非安全上下文 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走回退方案 */
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

const ORDER_COLUMNS: OrderColumnDef[] = [
  { key: "actions", label: "操作", align: "center", defaultVisible: true, sortable: false, minWidth: 110 },
  { key: "status", label: "订单状态", align: "left", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "market", label: "市场", align: "left", defaultVisible: true, sortable: true, minWidth: 80 },
  { key: "code", label: "股票代码", align: "left", defaultVisible: true, sortable: true, minWidth: 100 },
  { key: "name", label: "股票名称", align: "left", defaultVisible: true, sortable: true, minWidth: 220 },
  { key: "side", label: "方向", align: "center", defaultVisible: true, sortable: true, minWidth: 70 },
  { key: "orderType", label: "委托类型", align: "left", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "qty", label: "委托数量", align: "right", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "price", label: "委托价格", align: "right", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "triggerPrice", label: "触发价格", align: "right", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "currency", label: "币种", align: "left", defaultVisible: true, sortable: true, minWidth: 70 },
  { key: "tradedAt", label: "委托时间", align: "left", defaultVisible: true, sortable: true, minWidth: 210 },
  { key: "avgPrice", label: "成交均价", align: "right", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "filledQty", label: "成交数量", align: "right", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "amount", label: "成交金额", align: "right", defaultVisible: true, sortable: true, minWidth: 110 },
  { key: "remainingQty", label: "剩余挂单数量", align: "right", defaultVisible: true, sortable: true, minWidth: 110 },
  { key: "cancelledQty", label: "撤/废单数量", align: "right", defaultVisible: true, sortable: true, minWidth: 100 },
  { key: "validity", label: "有效期", align: "left", defaultVisible: true, sortable: true, minWidth: 100 },
  { key: "session", label: "时段", align: "left", defaultVisible: true, sortable: true, minWidth: 140 },
  { key: "triggerStatus", label: "触发状态", align: "left", defaultVisible: true, sortable: true, minWidth: 90 },
  { key: "orderNo", label: "订单号", align: "left", defaultVisible: true, sortable: true, minWidth: 150 },
  { key: "rejectReason", label: "驳回原因", align: "left", defaultVisible: true, sortable: true, minWidth: 90 },
];

const DEFAULT_ORDER_COLUMNS: OrderColumnPref[] = ORDER_COLUMNS.map((column) => ({
  key: column.key,
  visible: column.defaultVisible
}));

function normalizeOrderColumns(value: unknown): OrderColumnPref[] {
  if (!Array.isArray(value)) return DEFAULT_ORDER_COLUMNS.map((item) => ({ ...item }));
  const seen = new Set<OrderColumnKey>();
  const normalized: OrderColumnPref[] = [];
  value.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const raw = item as { key?: unknown; visible?: unknown };
    if (typeof raw.key !== "string") return;
    const key = raw.key as OrderColumnKey;
    if (!ORDER_COLUMNS.some((column) => column.key === key) || seen.has(key)) return;
    seen.add(key);
    normalized.push({ key, visible: raw.visible !== false });
  });
  ORDER_COLUMNS.forEach((column) => {
    if (!seen.has(column.key)) normalized.push({ key: column.key, visible: column.defaultVisible });
  });
  // 操作列固定首位（详情/编辑/删除入口），不随本地保存的顺序改变
  const actionsIndex = normalized.findIndex((item) => item.key === "actions");
  if (actionsIndex > 0) {
    const [actions] = normalized.splice(actionsIndex, 1);
    normalized.unshift(actions);
  }
  return normalized;
}

function isToday(value: string) {
  const traded = new Date(value);
  const now = new Date();
  return traded.getFullYear() === now.getFullYear()
    && traded.getMonth() === now.getMonth()
    && traded.getDate() === now.getDate();
}

function formatOrderTime(iso: string, market: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const zone = MARKET_ZONE[(market || "").toUpperCase()];
  return zone ? `${text} ${zone}` : text;
}

function currencyCode(market: string) {
  return CURRENCY_BY_MARKET[(market || "").toUpperCase()] ?? (marketMeta(market).code.replace(/[$¥₩]$/, "") || "—");
}

interface FilterOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

/** 券商风格筛选控件（参考图）：单行按钮，选中值/展开时蓝色边框高亮 */
function FilterSelect({
  display,
  value,
  icon,
  options,
  onSelect,
  highlight = false
}: {
  /** 按钮完整文字，如「市场:美股」「订单状态:已成交」 */
  display: string;
  value: string;
  icon?: React.ReactNode;
  options: FilterOption[];
  onSelect: (value: string) => void;
  /** 是否蓝色高亮（有选中值或菜单展开） */
  highlight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`inline-flex h-8 items-center gap-1.5 rounded-[9px] border px-3 text-xs font-medium transition-colors ${
          open || highlight
            ? "border-[#3297f6] bg-[#3297f6]/5 text-[#3297f6] dark:bg-[#3297f6]/10 dark:text-[#8ec2ff]"
            : "border-edge bg-white text-ink hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white dark:hover:bg-white/10"
        }`}
      >
        {icon}
        <span>{display}</span>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 opacity-70 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m5 7 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[150px] overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#1b2029]">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                option.value === value
                  ? "bg-[#3297f6]/15 font-bold text-[#3297f6] dark:text-[#8ec2ff]"
                  : "text-ink hover:bg-bg-gray dark:text-white dark:hover:bg-white/5"
              }`}
            >
              <span className="flex items-center gap-2">{option.icon}{option.label}</span>
              {option.value === value && (
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                  <path d="m2.4 6.4 2.5 2.5 4.7-5.8" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TradeOrdersPanel({
  orders,
  stockIcons = {},
  storageKey = "fire:orders:tab",
  onEdit,
  onDelete,
  deletingId = null,
  loading = false,
  bare = false,
  recordId,
  onRefresh
}: {
  orders: TradeOrder[];
  stockIcons?: Record<string, string>;
  storageKey?: string;
  onEdit?: (order: TradeOrder) => void;
  onDelete?: (order: TradeOrder) => void;
  deletingId?: string | null;
  /** 数据加载中（仅在没有已有数据时展示加载态，避免刷新闪加载） */
  loading?: boolean;
  /** 嵌入已有卡片时使用，去掉外层卡片样式 */
  bare?: boolean;
  /** 单只持仓场景：导出仅导出该持仓的订单 */
  recordId?: string;
  /** 刷新订单（实际重取数据） */
  onRefresh?: () => Promise<void> | void;
}) {
  const [tab, setTab] = usePersistedState<OrderTab>(storageKey, "today");
  const [marketFilter, setMarketFilter] = usePersistedState<string>(`${storageKey}:market`, "ALL");
  const [typeFilter, setTypeFilter] = usePersistedState<OrderTypeFilter>(`${storageKey}:type`, "all");
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilter>(`${storageKey}:status`, "all");
  const [timeFilter, setTimeFilter] = usePersistedState<TimeFilterState>(`${storageKey}:time`, DEFAULT_TIME_FILTER);
  const [columnPrefs, setColumnPrefs] = usePersistedState<OrderColumnPref[]>(ORDER_COLUMNS_KEY, DEFAULT_ORDER_COLUMNS.map((item) => ({ ...item })));
  const [sort, setSort] = usePersistedState<OrderSort | null>(`${storageKey}:sort`, { key: "tradedAt", dir: "desc" });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [columnManagerOpen, setColumnManagerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [timePos, setTimePos] = useState<{ left: number; bottom?: number; top?: number; up: boolean; caretLeft: number } | null>(null);
  const [timeDrag, setTimeDrag] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [timeDragged, setTimeDragged] = useState(false);
  const [timeSize, setTimeSize] = useState<{ width: number; height: number | null }>({ width: 680, height: null });
  const [timeDraft, setTimeDraft] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [timeMonth, setTimeMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [exportDetail, setExportDetail] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [recentExports, setRecentExports] = useState<ExportRecord[]>(() => typeof window === "undefined" ? [] : loadExportHistory());
  // 搜索（带联想）与分页
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = tab === "history" ? 5 : 9;
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportResultData | null>(null);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewFileRef = useRef<File | null>(null);
  const [detailOrder, setDetailOrder] = useState<TradeOrder | null>(null);
  const dragIndex = useRef<number | null>(null);
  const timeBtnRef = useRef<HTMLButtonElement>(null);
  const timeDragRef = useRef<{ pointerId: number; startX: number; startY: number; originDx: number; originDy: number; moved: boolean } | null>(null);
  const timeResizeRef = useRef<{ pointerId: number; startX: number; startY: number; originW: number; originH: number; moved: boolean } | null>(null);
  const managerScrollRef = useRef<number>(0);

  const columns = useMemo(() => normalizeOrderColumns(columnPrefs), [columnPrefs]);
  // 操作列（详情入口）始终展示，不参与隐藏；编辑/删除仅在传入回调时出现
  const visibleColumns = columns.filter((item) => item.visible || item.key === "actions");
  const manageColumns = columns.filter((item) => item.key !== "actions");
  // 各列按基准宽度占比分配（table-fixed）：隐藏任意列后其余列等比例自适应，不再挤压变形
  const totalColumnWidth = visibleColumns.reduce((sum, item) => sum + (ORDER_COLUMNS.find((column) => column.key === item.key)?.minWidth ?? 90), 0);

  async function handleCancel(order: TradeOrder) {
    if (!await appConfirm(`确认撤下这笔挂单？\n${order.name} · ${order.side === "buy" ? "买入" : "卖出"} ${order.qty} 股`, { title: "撤下挂单", danger: true })) return;
    try {
      const res = await fetch(`/api/v1/orders/${order.id}`, { method: "PATCH" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.error || "撤单失败", "err");
        return;
      }
      showToast("已撤单", "ok");
      if (onRefresh) await onRefresh();
    } catch {
      showToast("撤单失败", "err");
    }
  }

  const markets = useMemo(() => {
    const orderMarkets = [...new Set(orders.map((order) => order.market.toUpperCase()))];
    return ["US", "HK", "CN", "JP", "KR", ...orderMarkets].filter((key, index, keys) => orderMarkets.includes(key) && keys.indexOf(key) === index);
  }, [orders]);

  const visibleOrders = useMemo(() => orders.filter((order) => {
    if (tab === "today" ? !isToday(order.tradedAt) : isToday(order.tradedAt)) return false;
    if (marketFilter !== "ALL" && order.market.toUpperCase() !== marketFilter) return false;
    if (typeFilter !== "all" && orderTypeOf(order) !== typeFilter) return false;
    if (statusFilter !== "all" && order.status !== statusFilter) return false;
    if (timeFilter.mode !== "all" && timeFilter.start && timeFilter.end) {
      const key = localIso(new Date(order.tradedAt));
      if (key < timeFilter.start || key > timeFilter.end) return false;
    }
    return true;
  }), [orders, tab, marketFilter, typeFilter, statusFilter, timeFilter]);

  const sortedOrders = useMemo(() => {
    if (!sort || !sort.key || sort.key === "actions") return visibleOrders;
    const valueOf = (order: TradeOrder): string | number => {
      switch (sort.key) {
        case "orderNo": return order.orderNo;
        case "status": return order.status;
        case "market": return marketMeta(order.market).label;
        case "code": return order.code;
        case "name": return order.name;
        case "side": return order.side;
        case "orderType": return orderTypeLabel(order);
        case "qty":
        case "filledQty": return order.qty;
        case "price":
        case "avgPrice": return order.price;
        case "currency": return currencyCode(order.market);
        case "tradedAt": return new Date(order.tradedAt).getTime();
        case "amount": return order.amount;
        case "triggerPrice": return order.triggerPrice ?? 0;
        case "remainingQty": return order.status === "pending" ? order.qty : 0;
        case "cancelledQty": return order.status === "cancelled" || order.status === "expired" ? order.qty : 0;
        case "validity": return validityLabel(order);
        case "session": return order.session || "";
        case "triggerStatus": return order.triggerStatus || "";
        case "rejectReason": return "";
        default: return 0;
      }
    };
    const direction = sort.dir === "asc" ? 1 : -1;
    return [...visibleOrders].sort((a, b) => {
      const left = valueOf(a);
      const right = valueOf(b);
      const result = typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right, "zh-CN")
        : Number(left) - Number(right);
      return result * direction;
    });
  }, [visibleOrders, sort]);

  const toggleSort = (key: OrderColumnKey) => {
    setSort((current) => {
      if (!current || current.key !== key) return { key, dir: "asc" };
      return { key, dir: current.dir === "asc" ? "desc" : "asc" };
    });
  };

  // ---- 搜索（带联想） ----
  const searchKeyword = searchQuery.trim().toLowerCase();
  const searchedOrders = useMemo(() => {
    if (!searchKeyword) return sortedOrders;
    return sortedOrders.filter((order) => {
      const haystack = [order.code, order.name, order.orderNo, order.market]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" ");
      return haystack.includes(searchKeyword);
    });
  }, [sortedOrders, searchKeyword]);

  // 联想建议：基于输入框实时内容（未回车也联想），从当前筛选结果里提取 代码/名称/订单号 去重
  const inputKeyword = searchInput.trim().toLowerCase();
  const suggestions = useMemo(() => {
    if (!inputKeyword) return [] as Array<{ label: string; sub: string }>;
    const seen = new Set<string>();
    const out: Array<{ label: string; sub: string }> = [];
    for (const order of sortedOrders) {
      const code = String(order.code ?? "").toLowerCase();
      const name = String(order.name ?? "");
      const orderNo = String(order.orderNo ?? "");
      const candidates: Array<{ label: string; sub: string; key: string; match: string }> = [
        { label: order.code, sub: name, key: `code:${order.code.toUpperCase()}:${order.market}`, match: code },
        { label: name, sub: order.code, key: `name:${name}`, match: name.toLowerCase() },
        { label: order.orderNo, sub: `${order.code} · ${name}`, key: `no:${orderNo}`, match: orderNo.toLowerCase() }
      ];
      for (const candidate of candidates) {
        if (out.length >= 8) break;
        if (!candidate.match.includes(inputKeyword)) continue;
        if (seen.has(candidate.key)) continue;
        seen.add(candidate.key);
        out.push({ label: candidate.label, sub: candidate.sub });
      }
      if (out.length >= 8) break;
    }
    return out;
  }, [sortedOrders, inputKeyword]);

  // ---- 分页 ----
  const totalPages = Math.max(1, Math.ceil(searchedOrders.length / pageSize));
  const safePage = Math.min(pageIndex, totalPages - 1);
  const pageOrders = useMemo(
    () => searchedOrders.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [searchedOrders, safePage, pageSize]
  );
  // 筛选/搜索变化时回到第一页
  const prevSearch = useRef(searchKeyword);
  useEffect(() => {
    if (prevSearch.current !== searchKeyword) {
      prevSearch.current = searchKeyword;
      setPageIndex(0);
    }
  }, [searchKeyword]);
  // 其他筛选（tab/市场/类型/状态/时间/排序）变化也回第一页
  const prevFilters = useRef(`${tab}|${marketFilter}|${typeFilter}|${statusFilter}|${timeFilter.mode}|${timeFilter.start}|${timeFilter.end}|${sort?.key}|${sort?.dir}`);
  useEffect(() => {
    const key = `${tab}|${marketFilter}|${typeFilter}|${statusFilter}|${timeFilter.mode}|${timeFilter.start}|${timeFilter.end}|${sort?.key}|${sort?.dir}`;
    if (prevFilters.current !== key) {
      prevFilters.current = key;
      setPageIndex(0);
    }
  }, [tab, marketFilter, typeFilter, statusFilter, timeFilter, sort]);
  // 点击外部关闭联想
  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [searchOpen]);

  function resetFilters() {
    setMarketFilter("ALL");
    setTypeFilter("all");
    setStatusFilter("all");
    setTimeFilter(DEFAULT_TIME_FILTER);
    setTimeOpen(false);
    setTimePos(null);
    showToast("已重置全部筛选");
  }

  // 委托时间弹窗：fixed 定位 + 视口钳制（参考图 2——以按钮为锚点、左右不越界、优先向上）
  function openTimePicker() {
    const button = timeBtnRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const popupWidth = Math.min(680, viewportW - 16);
    const estimateHeight = timeFilter.mode === "custom" ? 460 : 110;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const up = spaceBelow < estimateHeight + 20 && spaceAbove >= spaceBelow;
    const left = Math.max(8, Math.min(rect.left, viewportW - popupWidth - 8));
    const caretLeft = Math.max(18, Math.min(rect.left + rect.width / 2 - left, popupWidth - 18));
    setTimePos({
      left,
      up,
      bottom: up ? window.innerHeight - rect.top + 10 : undefined,
      top: up ? undefined : rect.bottom + 10,
      caretLeft
    });
    const saved = loadTimePopover();
    setTimeDrag(saved ? { dx: saved.dx, dy: saved.dy } : { dx: 0, dy: 0 });
    setTimeDragged(saved ? saved.dx !== 0 || saved.dy !== 0 : false);
    setTimeSize(saved ? { width: saved.width, height: saved.height } : { width: Math.min(680, window.innerWidth - 16), height: null });
    setTimeOpen(true);
  }

  // 位置 / 大小变化自动保存（拖动结束、缩放结束、关闭时）
  const saveTimePopover = useCallback(() => {
    try {
      localStorage.setItem(TIME_POPOVER_KEY, JSON.stringify({ width: timeSize.width, height: timeSize.height, dx: timeDrag.dx, dy: timeDrag.dy }));
    } catch {
      /* 存储失败忽略 */
    }
  }, [timeSize, timeDrag]);

  // 日历跟随页面上下滚动：fixed 定位下用滚动增量同步补偿，保持与锚点内容联动
  const lastScrollRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    if (!timeOpen) return;
    lastScrollRef.current = { x: window.scrollX, y: window.scrollY };
    const onScroll = () => {
      const dx = window.scrollX - lastScrollRef.current.x;
      const dy = window.scrollY - lastScrollRef.current.y;
      lastScrollRef.current = { x: window.scrollX, y: window.scrollY };
      if (dx === 0 && dy === 0) return;
      setTimePos((pos) => pos ? {
        ...pos,
        left: pos.left - dx,
        bottom: pos.bottom != null ? pos.bottom + dy : undefined,
        top: pos.top != null ? pos.top - dy : undefined
      } : pos);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [timeOpen]);

  // 关闭时自动保存位置 / 大小
  useEffect(() => {
    if (!timeOpen) saveTimePopover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeOpen]);

  // 日历弹窗可拖动（K 线图设置面板同款交互）：手柄按下 → pointer capture → 移动更新偏移并钳制在视口内
  const beginTimeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    timeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originDx: timeDrag.dx,
      originDy: timeDrag.dy,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTimeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = timeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    setTimeDragged(true);
    setTimeDrag({ dx: drag.originDx + dx, dy: drag.originDy + dy });
  };
  const endTimeDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = timeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    timeDragRef.current = null;
    if (drag.moved) saveTimePopover();
  };

  // 日历可缩放（右下角手柄拖拽调整宽高，用户自由控制大小）
  const beginTimeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    timeResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originW: timeSize.width,
      originH: timeSize.height ?? 430,
      moved: false
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveTimeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = timeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const dx = event.clientX - resize.startX;
    const dy = event.clientY - resize.startY;
    if (!resize.moved && Math.hypot(dx, dy) < 4) return;
    resize.moved = true;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.max(360, Math.min(resize.originW + dx, viewportW - 16));
    const height = Math.max(260, Math.min(resize.originH + dy, viewportH - 16));
    setTimeSize({ width, height });
  };
  const endTimeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = timeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    timeResizeRef.current = null;
    if (resize.moved) saveTimePopover();
  };

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams({ scope: tab, market: marketFilter, type: typeFilter, status: statusFilter });
    if (timeFilter.mode !== "all") {
      const range = timeFilter.mode === "custom" ? { start: timeFilter.start, end: timeFilter.end } : timeRangeFor(timeFilter.mode);
      if (range.start) params.set("start", range.start);
      if (range.end) params.set("end", range.end);
    }
    if (recordId) params.set("recordId", recordId);
    return `/api/v1/orders/export?${params.toString()}`;
  }, [tab, marketFilter, typeFilter, statusFilter, timeFilter, recordId]);

  async function copyOrderNo(order: TradeOrder) {
    const ok = await copyText(order.orderNo);
    if (ok) {
      setCopiedId(order.id);
      showToast("订单号已复制");
      window.setTimeout(() => setCopiedId((current) => (current === order.id ? null : current)), 1200);
    } else {
      showToast("复制失败，请手动选择订单号", "err");
    }
  }

  async function downloadExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const url = `${exportUrl}${exportDetail ? "&detail=1" : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message || "导出失败");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      const fileName = match ? decodeURIComponent(match[1]) : `订单导出-${tab === "today" ? "当日" : "历史"}-${localIso(new Date())}.xlsx`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      const record: ExportRecord = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        range: `${timeFilter.mode === "all" ? (tab === "today" ? "当日" : "历史") : timeDisplay(timeFilter).replace("委托时间:", "")} · ${marketFilter === "ALL" ? "全部市场" : marketMeta(marketFilter).label} · ${typeFilter === "all" ? "全部类型" : typeFilter === "stock" ? "股票" : "ETF"} · ${statusFilter === "all" ? "全部状态" : STATUS_LABEL[statusFilter] ?? "其他"}`,
        status: "成功",
        fileName,
        time: new Date().toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
        size: blob.size >= 1024 ? `${(blob.size / 1024).toFixed(1)} KB` : `${blob.size} B`,
        url
      };
      const next = [record, ...recentExports].slice(0, 20);
      setRecentExports(next);
      try { localStorage.setItem(EXPORT_HISTORY_KEY, JSON.stringify(next)); } catch { /* 忽略存储失败 */ }
      showToast("订单已导出");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "导出失败", "err");
    } finally {
      setExporting(false);
    }
  }

  async function previewImport(file: File) {
    if (importing) return;
    setImporting(true);
    setImportError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/v1/orders/import?dryRun=1", { method: "POST", body: form });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error || "导入预览失败");
      setImportPreview(data as ImportResultData);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入预览失败");
    } finally {
      setImporting(false);
    }
  }

  async function confirmImport(file: File) {
    if (importing) return;
    setImporting(true);
    setImportError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/v1/orders/import", { method: "POST", body: form });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error || "导入失败");
      setImportPreview(data as ImportResultData);
      showToast(`已导入 ${data.imported} 笔订单`);
      window.dispatchEvent(new Event("fire:orders-updated"));
      if (onRefresh) await onRefresh();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  async function onPickImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    previewFileRef.current = file;
    await previewImport(file);
  }

  const updateColumns = (next: OrderColumnPref[], message?: string) => {
    setColumnPrefs(normalizeOrderColumns(next));
    if (message) showToast(message);
  };
  const toggleColumn = (index: number) => {
    const next = manageColumns.map((item, i) => i === index ? { ...item, visible: !item.visible } : item);
    const visibleCount = next.filter((item) => item.visible).length;
    if (visibleCount === 0) return showToast("至少保留一列", "err");
    updateColumns(next, "列显示设置已自动保存");
  };
  const toggleAllColumns = () => {
    const allVisible = manageColumns.every((item) => item.visible);
    if (allVisible) {
      updateColumns(manageColumns.map((item) => ({ ...item, visible: item.key === "orderNo" })), "已仅保留订单号列");
      return;
    }
    updateColumns(manageColumns.map((item) => ({ ...item, visible: true })), "已显示全部订单列");
  };
  const dropColumn = (to: number) => {
    if (dragIndex.current === null) return;
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === to) return;
    const next = [...manageColumns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateColumns(next, "拖动成功，订单列顺序已保存");
  };

  const renderCell = (order: TradeOrder, key: OrderColumnKey) => {
    const meta = marketMeta(order.market);
    const currency = meta.currency;
    switch (key) {
      case "orderNo":
        return (
          <button
            type="button"
            onClick={() => void copyOrderNo(order)}
            title="点击复制订单号"
            className={`group inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono tabular-nums transition-colors ${
              copiedId === order.id ? "text-brand-deep dark:text-[#8ec2ff]" : "text-muted hover:text-ink"
            }`}
          >
            <span className="truncate">{order.orderNo || "—"}</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 flex-none opacity-0 transition-opacity group-hover:opacity-100">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        );
      case "status":
        return (
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
            order.status === "filled" ? "text-down dark:text-[#4fd6a8]" :
            order.status === "pending" ? "text-[#3297f6] dark:text-[#6cb6ff]" :
            "text-up dark:text-[#ff8a8a]"
          }`}>
            <span className={`flex h-4 w-4 flex-none items-center justify-center rounded-full text-white ${
              order.status === "filled" ? "bg-down" :
              order.status === "pending" ? "bg-[#3297f6]" : "bg-up"
            }`}>
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                {order.status === "filled"
                  ? <path d="m2.5 6.4 2.4 2.4 4.7-5.4" />
                  : order.status === "pending"
                    ? <><path d="M6 3v3.4l2 1.4" /><circle cx="6" cy="6" r="3.4" strokeWidth="1.6" /></>
                    : <path d="M3 3l6 6M9 3l-6 6" />}
              </svg>
            </span>
            {STATUS_LABEL[order.status] ?? "已撤销"}
          </span>
        );
      case "market":
        return (
          <span className="inline-flex items-center gap-1.5">
            <MarketIcon market={order.market} size={15} />
            {meta.label}
          </span>
        );
      case "code":
        return <span className="font-mono font-semibold text-ink">{order.code}</span>;
      case "name": {
        const icon = stockIcons[`${order.market.toUpperCase()}:${order.code.toUpperCase()}`];
        return (
          <span className="inline-flex min-w-0 max-w-full items-center gap-2">
            <span className="relative flex-none">
              {icon ? <img src={icon} alt="" className="h-6 w-6 rounded-full object-cover" /> : <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-gray text-[11px] font-bold text-muted">{order.name.slice(0, 1)}</span>}
              <EtfDoubleBadge market={order.market} code={order.code} name={order.name} />
            </span>
            <span className="truncate font-medium text-ink" title={order.name}>{order.name}</span>
          </span>
        );
      }
      case "side":
        return (
          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${
            order.side === "buy" ? "bg-up-bg text-up" : order.side === "sell" ? "bg-down-bg text-down" : "bg-bg-gray text-muted"
          }`}>
            {order.side === "buy" ? "买入" : order.side === "sell" ? "卖出" : "股息"}
          </span>
        );
      case "orderType": return <span className="text-muted">{orderTypeLabel(order)}</span>;
      case "qty": return <span className="tabular-nums text-ink">{fmtQty(order.qty)}</span>;
      case "price": return <span className="tabular-nums text-ink">{fmtPrice(order.price, currency, order.market)}</span>;
      case "triggerPrice": return <span className="tabular-nums text-faint">{order.triggerPrice != null ? fmtPrice(order.triggerPrice, currency, order.market) : "—"}</span>;
      case "currency": return <span className="font-mono text-muted">{currencyCode(order.market)}</span>;
      case "tradedAt": return <span className="block truncate tabular-nums text-muted" title={formatOrderTime(order.tradedAt, order.market)}>{formatOrderTime(order.tradedAt, order.market)}</span>;
      case "avgPrice": return <span className="tabular-nums text-ink">{fmtPrice(order.price, currency, order.market)}</span>;
      case "filledQty": return (
        <span className="inline-flex items-center justify-end gap-1.5 tabular-nums">
          <span className={`h-1.5 w-1.5 flex-none rounded-full ${order.status === "filled" ? "bg-down" : order.status === "pending" ? "bg-[#3297f6]" : "bg-up"}`} />
          <span className={order.status === "filled" ? "text-ink" : "text-muted"}>{order.status === "filled" ? fmtQty(order.qty) : "0"}</span>
        </span>
      );
      case "amount": return <span className="font-semibold tabular-nums text-ink">{fmtMoney(order.amount, currency)}</span>;
      case "remainingQty": return <span className="tabular-nums text-muted">{order.status === "pending" ? fmtQty(order.qty) : "0"}</span>;
      case "cancelledQty": return <span className="tabular-nums text-muted">{order.status === "cancelled" || order.status === "expired" ? fmtQty(order.qty) : "0"}</span>;
      case "validity": return <span className="text-muted">{validityLabel(order)}</span>;
      case "session": return <span className="text-muted">{order.session || "盘中+盘前盘后"}</span>;
      case "triggerStatus": return <span className="text-muted">{order.triggerStatus || "—"}</span>;
      case "rejectReason": return <span className="text-faint">—</span>;
      case "actions":
        return (
          <div className="inline-flex items-center gap-1">
            {order.status === "pending" && (
              <button
                type="button"
                onClick={() => void handleCancel(order)}
                title="撤单"
                aria-label="撤单"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-bg-gray hover:text-ink dark:border-white/10 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                  <path d="M4 8h16" /><path d="M6 8l1 12h10l1-12" /><path d="M9 8V6a2 2 0 0 1 4 0v2" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => setDetailOrder(order)}
              title="查看订单详情"
              aria-label="查看订单详情"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-bg-gray hover:text-ink dark:border-white/10 dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5">
                <path d="M9 5h11M9 10h11M9 15h11M9 20h11" /><path d="M4 5h1M4 10h1M4 15h1M4 20h1" />
              </svg>
            </button>
            {onEdit && <button type="button" onClick={() => onEdit(order)} className="btn btn-ghost btn-sm">编辑</button>}
            {onDelete && (
              <button type="button" disabled={deletingId === order.id} onClick={() => onDelete(order)} className="btn btn-ghost btn-sm text-down disabled:opacity-50">
                {deletingId === order.id ? "删除中…" : <DeleteIcon size={13} />}
              </button>
            )}
          </div>
        );
      default: return null;
    }
  };

  const Wrapper = bare ? "div" : "section";
  return (
    <Wrapper className={bare ? "overflow-hidden" : "card overflow-hidden"}>
      <div className="trade-orders-toolbar flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-3.5">
        <div className="flex items-center gap-6">
          {([["today", "当日订单"], ["history", "历史订单"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`relative px-0.5 pb-2.5 text-sm font-semibold transition-colors ${
                tab === key ? "text-ink dark:text-white" : "text-muted hover:text-ink"
              }`}
            >
              {label}
              {tab === key && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-[#3297f6]" />}
            </button>
          ))}
        </div>
        <div className="trade-orders-actions flex items-center gap-2">
          <div ref={searchRef} className="relative">
            <div className="relative">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint">
                <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
              </svg>
              <input
                value={searchInput}
                onChange={(event) => {
                  // 输入即实时过滤（searchQuery 同步），回车/点击联想仅用于收尾与关闭下拉
                  setSearchInput(event.target.value);
                  setSearchQuery(event.target.value);
                  setSearchOpen(true);
                }}
                onFocus={() => setSearchOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setSearchQuery(event.currentTarget.value);
                    setPageIndex(0);
                    setSearchOpen(false);
                  } else if (event.key === "Escape") {
                    setSearchQuery("");
                    setSearchInput("");
                    setSearchOpen(false);
                  }
                }}
                placeholder="搜索代码/名称/订单号"
                className="h-8 w-[180px] rounded-[9px] border border-edge bg-white pl-8 pr-2.5 text-xs text-ink placeholder:text-faint transition-colors focus:border-edge-strong dark:border-white/10 dark:bg-[#1c222d] dark:text-white"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(""); setSearchInput(""); setSearchOpen(false); }}
                  aria-label="清除搜索"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full text-faint transition-colors hover:bg-bg-gray hover:text-ink"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-3 w-3"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              )}
            </div>
            {searchOpen && inputKeyword && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-[10px] border border-edge-strong bg-white py-1 shadow-pop dark:border-white/10 dark:bg-[#1c222d]">
                {suggestions.map((suggestion, index) => (
                  <button
                    key={`${suggestion.label}:${index}`}
                    type="button"
                    onClick={() => {
                      setSearchQuery(suggestion.label);
                      setSearchInput(suggestion.label);
                      setPageIndex(0);
                      setSearchOpen(false);
                    }}
                    className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors hover:bg-bg-gray dark:hover:bg-white/10"
                  >
                    <span className="min-w-0 truncate font-medium text-ink">{suggestion.label}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-[11px] text-faint">{suggestion.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="text-xs text-muted">{searchedOrders.length} 笔</span>
          {onRefresh && <RefreshButton onClick={() => void onRefresh()} title="刷新订单" />}
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            title="导出订单（xlsx）"
            className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-edge-strong bg-white px-2.5 text-xs font-semibold text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] dark:bg-[#1c222d] dark:text-white dark:hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            导出
          </button>
          <button
            type="button"
            onClick={() => {
              setImportPreview(null);
              setImportError("");
              setImportOpen(true);
            }}
            title="导入券商订单（xlsx）"
            className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-edge-strong bg-white px-2.5 text-xs font-semibold text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] dark:bg-[#1c222d] dark:text-white dark:hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M12 15V3m0 0 4 4m-4-4-4 4" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            导入
          </button>
          <button
            type="button"
            onClick={() => setColumnManagerOpen(true)}
            title="显示与排序订单列"
            aria-label="显示与排序订单列"
            className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-edge-strong bg-white text-muted shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover hover:text-ink active:scale-[.97] dark:bg-[#1c222d] dark:text-white dark:hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M4 5h16l-6.35 7.15v5.25l-3.3 1.65v-6.9L4 5Z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 border-b border-edge px-5 py-2.5">
        <FilterSelect
          display={marketFilter === "ALL" ? "市场" : `市场:${marketMeta(marketFilter).label}`}
          value={marketFilter}
          highlight={marketFilter !== "ALL"}
          options={[
            { value: "ALL", label: "全部" },
            ...markets.map((key) => ({ value: key, label: marketMeta(key).label, icon: <MarketIcon market={key} size={14} /> }))
          ]}
          onSelect={setMarketFilter}
        />
        <FilterSelect
          display={typeFilter === "all" ? "标的类型" : `标的类型:${typeFilter === "stock" ? "股票" : "ETF"}`}
          value={typeFilter}
          highlight={typeFilter !== "all"}
          options={[
            { value: "all", label: "全部" },
            { value: "stock", label: "股票" },
            { value: "etf", label: "ETF" }
          ]}
          onSelect={(value) => setTypeFilter(value as OrderTypeFilter)}
        />
        <FilterSelect
          display={statusFilter === "all" ? "订单状态" : `订单状态:${STATUS_LABEL[statusFilter] ?? "其他"}`}
          value={statusFilter}
          highlight={statusFilter !== "all"}
          options={[
            { value: "all", label: "全部" },
            { value: "filled", label: "已成交" },
            { value: "pending", label: "待成交" },
            { value: "cancelled", label: "已撤销" },
            { value: "expired", label: "已失效" }
          ]}
          onSelect={(value) => setStatusFilter(value as StatusFilter)}
        />
        <div className="relative">
          <button
            ref={timeBtnRef}
            type="button"
            onClick={() => (timeOpen ? setTimeOpen(false) : openTimePicker())}
            aria-expanded={timeOpen}
            className={`inline-flex h-8 items-center gap-1.5 rounded-[9px] border px-3 text-xs font-medium transition-colors ${
              timeOpen || timeFilter.mode !== "all"
                ? "border-[#3297f6] bg-[#3297f6]/5 text-[#3297f6] dark:bg-[#3297f6]/10 dark:text-[#8ec2ff]"
                : "border-edge bg-white text-ink hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white dark:hover:bg-white/10"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3.5 w-3.5">
              <path d="M4 5h16M7 3v4m10-4v4M5 9h14v11H5z" /><path d="m9 14 2 2 4-5" />
            </svg>
            <span>{timeDisplay(timeFilter)}</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 opacity-70 transition-transform ${timeOpen ? "rotate-180" : ""}`}>
              <path d="m5 7 5 5 5-5" />
            </svg>
          </button>
          {timeOpen && timePos && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setTimeOpen(false)} />
              <div
                style={{
                  left: Math.max(8, Math.min(timePos.left + timeDrag.dx, window.innerWidth - timeSize.width - 8)),
                  width: timeSize.width,
                  height: timeSize.height ?? undefined,
                  bottom: timePos.up && timePos.bottom != null ? Math.max(8, Math.min(timePos.bottom - timeDrag.dy, window.innerHeight - 8)) : undefined,
                  top: timePos.up || timePos.top == null ? undefined : Math.max(8, Math.min(timePos.top + timeDrag.dy, window.innerHeight - 8)),
                  maxHeight: timePos.up && timePos.bottom != null ? Math.max(180, window.innerHeight - timePos.bottom - 6) : undefined
                }}
                className="fixed z-40 overflow-y-auto rounded-2xl border border-edge-strong bg-white p-4 shadow-2xl dark:border-white/10 dark:bg-[#1b2029]"
              >
                {!timeDragged && (timePos.up ? (
                  <span className="absolute -bottom-[5px] z-10 h-2.5 w-2.5 rotate-45 border-b border-r border-edge-strong bg-white dark:border-white/10 dark:bg-[#1b2029]" style={{ left: timePos.caretLeft - 5 }} />
                ) : (
                  <span className="absolute -top-[5px] z-10 h-2.5 w-2.5 rotate-45 border-l border-t border-edge-strong bg-white dark:border-white/10 dark:bg-[#1b2029]" style={{ left: timePos.caretLeft - 5 }} />
                ))}
                <div
                  onPointerDown={beginTimeDrag}
                  onPointerMove={moveTimeDrag}
                  onPointerUp={endTimeDrag}
                  onPointerCancel={endTimeDrag}
                  className="mb-2 flex cursor-grab touch-none select-none items-center justify-center gap-1 py-0.5 text-muted transition-colors hover:text-ink active:cursor-grabbing"
                  title="拖动移动日历"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><circle cx="8" cy="6" r="1.3" /><circle cx="16" cy="6" r="1.3" /><circle cx="8" cy="12" r="1.3" /><circle cx="16" cy="12" r="1.3" /><circle cx="8" cy="18" r="1.3" /><circle cx="16" cy="18" r="1.3" /></svg>
                </div>
                <div
                  onPointerDown={beginTimeResize}
                  onPointerMove={moveTimeResize}
                  onPointerUp={endTimeResize}
                  onPointerCancel={endTimeResize}
                  className="absolute bottom-0 right-0 z-10 h-6 w-6 cursor-nwse-resize touch-none select-none text-faint opacity-50 transition-opacity hover:opacity-100"
                  title="拖动调整日历大小"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="absolute bottom-1 right-1 h-3.5 w-3.5">
                    <path d="m20 8-12 12M20 20h-9" />
                  </svg>
                </div>
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  {([["all", "全部"], ["today", "当日"], ["7d", "近7天"], ["30d", "近30天"], ["1y", "近1年"], ["custom", "自定义"]] as const).map(([mode, label]) => {
                    const active = timeFilter.mode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          if (mode === "custom") {
                            setTimeDraft({ start: timeFilter.start, end: timeFilter.end });
                            setTimeFilter({ mode: "custom", ...timeRangeFor("all") });
                          } else {
                            setTimeFilter({ mode, ...timeRangeFor(mode) });
                            setTimeOpen(false);
                          }
                        }}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                          active
                            ? "border-[#3297f6] bg-[#3297f6]/10 text-[#3297f6]"
                            : "border-edge text-muted hover:bg-bg-gray hover:text-ink dark:hover:bg-white/5"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {timeFilter.mode === "custom" && (
                  <>
                    <div className="mb-3 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setTimeMonth((value) => shiftMonth(value, -1))}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted hover:bg-bg-gray"
                        aria-label="上个月"
                      >
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m12 15-5-5 5-5" /></svg>
                      </button>
                      <strong className="text-sm">选择委托时间区间</strong>
                      <button
                        type="button"
                        onClick={() => setTimeMonth((value) => shiftMonth(value, 1))}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-edge text-muted hover:bg-bg-gray"
                        aria-label="下个月"
                      >
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="m8 5 5 5-5 5" /></svg>
                      </button>
                    </div>
                    <div className="grid gap-5 md:grid-cols-2">
                      {[timeMonth, shiftMonth(timeMonth, 1)].map((month) => {
                        const first = new Date(month);
                        first.setDate(1 - first.getDay());
                        const days = Array.from({ length: 42 }, (_, index) => {
                          const value = new Date(first);
                          value.setDate(first.getDate() + index);
                          return value;
                        });
                        return (
                          <div key={month.getTime()} className="min-w-0 flex-1">
                            <h4 className="mb-3 text-center text-sm font-bold">{month.getFullYear()} 年 {month.getMonth() + 1} 月</h4>
                            <div className="grid grid-cols-7 gap-1 border-b border-edge pb-2 text-center text-[11px] font-semibold text-muted">{WEEKDAYS.map((day) => <span key={day}>周{day}</span>)}</div>
                            <div className="mt-2 grid grid-cols-7 gap-1">
                              {days.map((date) => {
                                const key = localIso(date);
                                const inMonth = date.getMonth() === month.getMonth();
                                const edge = key === timeDraft.start || key === timeDraft.end;
                                const between = Boolean(timeDraft.start && timeDraft.end && key > timeDraft.start && key < timeDraft.end);
                                const isToday = key === localIso(new Date());
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    onClick={() => setTimeDraft((current) => !current.start || current.end ? { start: key, end: "" } : key < current.start ? { start: key, end: current.start } : { start: current.start, end: key })}
                                    className={`relative flex aspect-square min-h-8 items-center justify-center rounded-lg text-xs transition-colors ${
                                      edge ? "bg-[#3297f6] font-bold text-white" : between ? "bg-[#3297f6]/15 text-ink" : inMonth ? "text-ink hover:bg-bg-gray" : "text-faint hover:bg-bg-gray"
                                    }`}
                                  >
                                    {date.getDate()}{isToday && !edge && <i className="absolute bottom-1 h-1 w-1 rounded-full bg-[#3297f6]" />}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-3">
                      <span className="text-xs text-muted">{timeDraft.start ? timeDraft.start.slice(5).replace("-", "/") : "开始日期"} — {timeDraft.end ? timeDraft.end.slice(5).replace("-", "/") : "结束日期"}</span>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => { setTimeDraft({ start: "", end: "" }); setTimeFilter(DEFAULT_TIME_FILTER); setTimeOpen(false); }} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:bg-bg-gray">清除</button>
                        <button type="button" disabled={!timeDraft.start || !timeDraft.end} onClick={() => { setTimeFilter({ mode: "custom", ...timeDraft }); setTimeOpen(false); }} className="rounded-lg border border-edge-strong bg-white px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40 dark:bg-[#252c39]">应用区间</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={resetFilters}
          title="重置"
          aria-label="重置筛选"
          className="ml-auto inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-edge bg-white text-muted transition-colors hover:border-edge-strong hover:text-ink dark:border-white/10 dark:bg-[#1c222d] dark:text-white/70 dark:hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M3 6h18M8 6V4h8v2m-9 2 1 12h8l1-12" />
          </svg>
        </button>
      </div>

      {loading && orders.length === 0 ? (
        <div className="py-14 text-center text-sm text-faint">正在加载订单…</div>
      ) : searchedOrders.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted">
          {searchKeyword ? "没有匹配的订单（试试代码/名称/订单号）" : tab === "today" ? "当日暂无成交订单" : "暂无历史订单"}
          {(marketFilter !== "ALL" || statusFilter !== "all") && "（可调整上方筛选查看全部）"}
        </div>
      ) : (
        <>
        <div className="orders-scroll">
          <table className="w-full table-fixed whitespace-nowrap text-xs" style={{ minWidth: `${totalColumnWidth + 8}px` }}>
            <thead>
              <tr className="bg-bg-gray text-[11px] font-semibold text-muted dark:bg-white/5">
                {visibleColumns.map((item) => {
                  const column = ORDER_COLUMNS.find((c) => c.key === item.key)!;
                  const active = sort?.key === item.key;
                  return (
                    <th key={item.key} style={{ width: column.minWidth }} className={`overflow-hidden px-3 py-2.5 ${column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left"}`}>
                      {column.sortable ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(item.key)}
                          title="点击排序"
                          className={`inline-flex select-none items-center gap-1 transition-colors ${
                            column.align === "right" ? "flex-row-reverse" : ""
                          } ${active ? "text-ink dark:text-white" : "hover:text-ink"}`}
                        >
                          {column.label}
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className={`h-3 w-3 ${active ? "opacity-100" : "opacity-25"}`}>
                            <path d={active && sort?.dir === "asc" ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} />
                          </svg>
                        </button>
                      ) : column.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageOrders.map((order) => (
                <tr key={order.id} className={`border-t border-edge transition-colors ${
                  order.side === "buy"
                    ? "bg-[#fdf3f3] hover:bg-[#fbeaea] dark:bg-[#2b1717]/70 dark:hover:bg-[#3a1c1c]/80"
                    : order.side === "sell"
                      ? "bg-[#effaf5] hover:bg-[#e2f6ec] dark:bg-[#10291f]/70 dark:hover:bg-[#143728]/80"
                      : ""
                }`}>
                  {visibleColumns.map((item) => {
                    const column = ORDER_COLUMNS.find((c) => c.key === item.key)!;
                    return (
                      <td key={item.key} style={{ width: column.minWidth }} className={`overflow-hidden px-3 py-2.5 ${column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left"}`}>
                        {renderCell(order, item.key)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge px-5 py-2.5">
            <span className="text-[11px] text-faint">
              第 {safePage + 1} / {totalPages} 页 · 共 {searchedOrders.length} 笔
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPageIndex(Math.max(0, safePage - 1))}
                title="上一页"
                aria-label="上一页"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-bg-gray hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/10 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, index) => {
                // 页码窗口：当前页居中，超出 7 页时取窗口
                const start = Math.max(0, Math.min(safePage - 3, totalPages - 7));
                const pageNo = start + index;
                if (pageNo >= totalPages) return null;
                return (
                  <button
                    key={pageNo}
                    type="button"
                    onClick={() => setPageIndex(pageNo)}
                    className={`inline-flex h-7 min-w-7 items-center justify-center rounded-[8px] px-1.5 text-xs transition-colors ${
                      pageNo === safePage
                        ? "bg-ink font-semibold text-white dark:bg-white dark:text-black"
                        : "border border-edge text-muted hover:bg-bg-gray hover:text-ink dark:border-white/10 dark:hover:bg-white/10"
                    }`}
                  >
                    {pageNo + 1}
                  </button>
                );
              })}
              <button
                type="button"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPageIndex(Math.min(totalPages - 1, safePage + 1))}
                title="下一页"
                aria-label="下一页"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-bg-gray hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 dark:border-white/10 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
          </div>
        )}
        </>
      )}

      {columnManagerOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-start justify-center p-6 pt-[12vh]">
          <div className="absolute inset-0 bg-black/40" onClick={() => setColumnManagerOpen(false)} />
          <div className="relative w-full max-w-[320px] overflow-clip rounded-[16px] border border-edge bg-white shadow-pop dark:bg-[#1c1c1e]">
            <div className="flex items-center justify-between gap-2 border-b border-edge px-4 py-3">
              <h3 className="text-base font-semibold text-ink">需要显示哪些列</h3>
              <button
                type="button"
                onClick={() => setColumnManagerOpen(false)}
                aria-label="关闭"
                className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto py-1.5">
              <div className="mx-2 flex items-center rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-gray">
                <FlatCheckbox checked={manageColumns.every((item) => item.visible)} onChange={toggleAllColumns} label="全部" />
              </div>
              {manageColumns.map((item, index) => (
                <div key={item.key} onDragOver={(event) => event.preventDefault()} onDrop={() => dropColumn(index)} className="mx-2 flex items-center gap-1.5 rounded-[8px] px-2 py-1.5 transition-colors hover:bg-bg-gray">
                  <FlatCheckbox checked={item.visible} onChange={() => toggleColumn(index)} label={ORDER_COLUMNS.find((column) => column.key === item.key)?.label ?? item.key} dim={!item.visible} />
                  <button
                    type="button"
                    draggable
                    onDragStart={(event) => { dragIndex.current = index; event.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { dragIndex.current = null; }}
                    className="drag-handle inline-flex h-6 w-6 cursor-grab items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-gray hover:text-ink active:cursor-grabbing"
                    aria-label={`拖动 ${ORDER_COLUMNS.find((column) => column.key === item.key)?.label ?? item.key} 排序`}
                    title="拖动排序"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><circle cx="8" cy="6" r="1.4" /><circle cx="16" cy="6" r="1.4" /><circle cx="8" cy="12" r="1.4" /><circle cx="16" cy="12" r="1.4" /><circle cx="8" cy="18" r="1.4" /><circle cx="16" cy="18" r="1.4" /></svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
        ,
        document.body
      )}

      {exportOpen && (
        <div className="fixed inset-0 z-[9999] flex items-start justify-center p-6 pt-[14vh]">
          <div className="absolute inset-0 bg-black/40" onClick={() => setExportOpen(false)} />
          <div className="relative max-h-[85vh] w-full max-w-[620px] overflow-y-auto rounded-[18px] border border-edge bg-white shadow-pop dark:bg-[#1c1c1e]">
            <div className="flex items-center justify-between gap-2 border-b border-edge px-5 py-4">
              <div>
                <h3 className="text-base font-bold text-ink">导出订单</h3>
                <p className="mt-0.5 text-xs text-muted">导出为 Excel（.xlsx）文件</p>
              </div>
              <button
                type="button"
                onClick={() => setExportOpen(false)}
                aria-label="关闭"
                className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div className="rounded-[12px] bg-bg-gray/70 px-4 py-3 text-xs dark:bg-white/5">
                <p className="font-semibold text-ink">当前筛选条件</p>
                <p className="mt-1.5 text-muted">
                  委托时间：<span className="text-ink">{timeFilter.mode === "all" ? (tab === "today" ? "当日" : "历史") : timeDisplay(timeFilter).replace("委托时间:", "")}</span>
                  <span className="mx-2 text-faint">·</span>
                  市场：<span className="text-ink">{marketFilter === "ALL" ? "全部" : marketMeta(marketFilter).label}</span>
                  <span className="mx-2 text-faint">·</span>
                  标的类型：<span className="text-ink">{typeFilter === "all" ? "全部" : typeFilter === "stock" ? "股票" : "ETF"}</span>
                  <span className="mx-2 text-faint">·</span>
                  订单状态：<span className="text-ink">{statusFilter === "all" ? "全部" : STATUS_LABEL[statusFilter] ?? "其他"}</span>
                </p>
              </div>
              <p className="text-xs leading-relaxed text-muted">
                将导出当前筛选条件下的 <strong className="text-ink">{sortedOrders.length}</strong> 笔订单，共 21 列：订单状态、市场、股票代码、股票名称、方向、委托类型、委托数量、委托价格、触发价格、币种、委托时间、成交均价、成交数量、成交金额、剩余挂单数量、撤/废单数量、有效期、时段、触发状态、订单号、驳回原因。
              </p>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-[12px] bg-bg-gray/70 px-4 py-3 dark:bg-white/5">
                <span className={`mt-px flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[3px] border transition-colors ${
                  exportDetail ? "border-transparent bg-ink text-white dark:bg-white dark:text-black" : "border-edge-strong bg-transparent text-transparent"
                }`}>
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                    <path d="m2.4 6.4 2.5 2.5 4.7-5.8" />
                  </svg>
                </span>
                <input type="checkbox" checked={exportDetail} onChange={(event) => setExportDetail(event.target.checked)} className="sr-only" />
                <span>
                  <span className="text-xs font-semibold text-ink">同时导出订单明细</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">订单明细提供单个订单的全部数据（费用、已实现盈亏、成交后持仓、备注等），作为「订单明细」工作表一并导出。</span>
                </span>
              </label>
            </div>
            <div className="border-t border-edge px-5 py-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h4 className="text-xs font-bold text-ink">最近导出</h4>
                <span className="text-[11px] text-faint">仅显示最近 {recentExports.length > 0 ? "20" : "0"} 条记录</span>
              </div>
              {recentExports.length === 0 ? (
                <div className="rounded-[12px] bg-bg-gray/60 py-8 text-center text-xs text-faint dark:bg-white/5">暂无导出记录</div>
              ) : (
                <div className="overflow-x-auto rounded-[12px] border border-edge">
                  <table className="w-full min-w-[620px] whitespace-nowrap text-[11px]">
                    <thead>
                      <tr className="bg-bg-gray text-muted dark:bg-white/5">
                        <th className="px-3 py-2 text-left font-semibold">订单导出时间范围</th>
                        <th className="px-3 py-2 text-left font-semibold">状态</th>
                        <th className="px-3 py-2 text-left font-semibold">文件名称</th>
                        <th className="px-3 py-2 text-left font-semibold">导出时间</th>
                        <th className="px-3 py-2 text-right font-semibold">文件大小</th>
                        <th className="px-3 py-2 text-center font-semibold">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentExports.map((record) => (
                        <tr key={record.id} className="border-t border-edge">
                          <td className="px-3 py-2 text-muted">{record.range}</td>
                          <td className="px-3 py-2"><span className="inline-flex items-center gap-1 text-down"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="m2.5 6.4 2.4 2.4 4.7-5.4" /></svg>{record.status}</span></td>
                          <td className="max-w-[160px] truncate px-3 py-2 text-ink" title={record.fileName}>{record.fileName}</td>
                          <td className="px-3 py-2 tabular-nums text-muted">{record.time}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{record.size}</td>
                          <td className="px-3 py-2 text-center"><a href={record.url} download className="text-[11px] font-semibold text-muted transition-colors hover:text-ink">重新导出</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2.5 border-t border-edge px-5 py-3.5">
              <button type="button" onClick={() => setExportOpen(false)} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" disabled={exporting} onClick={() => void downloadExport()} className="btn btn-line btn-sm disabled:opacity-60">{exporting ? "导出中…" : "导出"}</button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="fixed inset-0 z-[9999] flex items-start justify-center p-6 pt-[14vh]">
          <div className="absolute inset-0 bg-black/40" onClick={() => setImportOpen(false)} />
          <div className="relative max-h-[85vh] w-full max-w-[640px] overflow-y-auto rounded-[18px] border border-edge bg-white shadow-pop dark:bg-[#1c1c1e]">
            <div className="flex items-center justify-between gap-2 border-b border-edge px-5 py-4">
              <div>
                <h3 className="text-base font-bold text-ink">导入订单</h3>
                <p className="mt-0.5 text-xs text-muted">上传券商导出的 .xlsx 历史订单</p>
              </div>
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                aria-label="关闭"
                className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={(event) => void onPickImportFile(event)} />
              {!importPreview && !importing && (
                <>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-edge-strong bg-bg-gray/50 px-6 py-10 text-center transition-colors hover:bg-bg-gray dark:bg-white/5 dark:hover:bg-white/10"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8 text-muted">
                      <path d="M12 15V3m0 0 4 4m-4-4-4 4" />
                      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                    </svg>
                    <span className="text-sm font-semibold text-ink">选择 .xlsx 文件</span>
                    <span className="max-w-[420px] text-[11px] leading-relaxed text-muted">
                      格式与「导出订单」一致（21 列：订单状态、市场、股票代码…），长桥等券商的历史订单导出可直接导入；仅导入「已成交」订单，按订单号去重。
                    </span>
                  </button>
                  <a href="/docs/broker-orders-format.md" target="_blank" rel="noreferrer" className="block text-center text-[11px] text-muted transition-colors hover:text-ink">查看导入格式规范</a>
                </>
              )}
              {importing && (
                <div className="flex flex-col items-center justify-center gap-3 rounded-[14px] bg-bg-gray/50 py-10 dark:bg-white/5">
                  <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 animate-spin text-brand"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
                  <span className="text-xs text-muted">正在解析文件…</span>
                </div>
              )}
              {importError && (
                <div className="rounded-[12px] border border-down/30 bg-down/10 px-4 py-3 text-xs leading-relaxed text-down">{importError}</div>
              )}
              {importPreview && (
                <>
                  <div className="rounded-[12px] bg-bg-gray/70 px-4 py-3 text-xs dark:bg-white/5">
                    <p className="font-semibold text-ink">{importPreview.fileName}</p>
                    <p className="mt-1.5 text-muted">
                      共识别 <span className="text-ink">{importPreview.totalFilled}</span> 笔已成交 · 将导入 <span className="font-semibold text-ink">{importPreview.imported}</span> 笔 · 跳过 <span className="text-ink">{importPreview.skipped}</span> 笔 · 重复 <span className="text-ink">{importPreview.duplicated}</span> 笔
                    </p>
                  </div>
                  {importPreview.groups.length > 0 && (
                    <div className="overflow-x-auto rounded-[12px] border border-edge">
                      <table className="w-full min-w-[520px] whitespace-nowrap text-[11px]">
                        <thead>
                          <tr className="bg-bg-gray text-muted dark:bg-white/5">
                            <th className="px-3 py-2 text-left font-semibold">股票</th>
                            <th className="px-3 py-2 text-left font-semibold">代码</th>
                            <th className="px-3 py-2 text-right font-semibold">订单数</th>
                            <th className="px-3 py-2 text-left font-semibold">结果</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.groups.map((group, index) => (
                            <tr key={`${group.market}:${group.code}`} className="border-t border-edge">
                              <td className="px-3 py-2 text-ink">
                                <span className="mr-1.5 inline-flex flex-none items-center justify-center rounded-[4px] px-1.5 py-px text-[10px] font-semibold text-white" style={{ backgroundColor: marketMeta(group.market).code === "USD" ? "#3b82f6" : marketMeta(group.market).code === "HKD" ? "#8b5cf6" : "#e0919f" }}>{group.market}</span>
                                {group.name}
                              </td>
                              <td className="px-3 py-2 font-mono text-muted">{group.code}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-muted">{group.orderCount}</td>
                              <td className="px-3 py-2">
                                {group.action === "imported" ? (
                                  <span className="inline-flex items-center gap-1 text-up">
                                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="m2.5 6.4 2.4 2.4 4.7-5.4" /></svg>
                                    {group.createdRecord ? "新建记录" : "导入"}
                                    {!importPreview.dryRun && ` · 持仓 ${group.finalQty}`}
                                  </span>
                                ) : (
                                  <span className="text-faint">{group.reason || "跳过"}</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex justify-end gap-2.5 border-t border-edge px-5 py-3.5">
              <button type="button" onClick={() => setImportOpen(false)} className="btn btn-ghost btn-sm">关闭</button>
              {importPreview && importPreview.dryRun && (
                <button
                  type="button"
                  disabled={importing || importPreview.imported === 0}
                  onClick={() => fileInputRef.current?.click()}
                  className="btn btn-line btn-sm disabled:opacity-60"
                >
                  选择其他文件
                </button>
              )}
              {importPreview && importPreview.dryRun && (
                <button
                  type="button"
                  disabled={importing || importPreview.imported === 0}
                  onClick={() => confirmImport(previewFileRef.current!)}
                  className="btn btn-line btn-sm disabled:opacity-60"
                >
                  {importing ? "导入中…" : `确认导入 ${importPreview.imported} 笔`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {detailOrder && (() => {
        const detail = detailOrder;
        const meta = marketMeta(detail.market);
        const currency = meta.currency;
        const icon = stockIcons[`${detail.market.toUpperCase()}:${detail.code.toUpperCase()}`];
        const rows: Array<[string, React.ReactNode]> = [
          ["证券账户", <span key="a" className="text-ink">{detail.broker || "—"}</span>],
          ["委托单号", (
            <span key="b" className="inline-flex items-center gap-1.5">
              <span className="font-mono tabular-nums text-ink">{detail.orderNo || "—"}</span>
              {detail.orderNo && (
                <button
                  type="button"
                  onClick={() => void copyOrderNo(detail)}
                  title="复制订单号"
                  aria-label="复制订单号"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-md text-faint transition-colors hover:bg-bg-gray hover:text-ink dark:hover:bg-white/10"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                    <rect x="9" y="9" width="12" height="12" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              )}
            </span>
          )],
          ["订单类型", <span key="c" className="text-ink">{orderTypeLabel(detail)}</span>],
          ["方向", (
            <span key="d" className={`font-bold ${detail.side === "buy" ? "text-up" : detail.side === "sell" ? "text-down" : "text-brand-deep"}`}>
              {detail.side === "buy" ? "买入" : detail.side === "sell" ? "卖出" : "股息"}
            </span>
          )],
          ["委托价格", <span key="e" className="tabular-nums text-ink">{fmtPrice(detail.price, currency, detail.market)}</span>],
          ["委托数量", <span key="f" className="tabular-nums text-ink">{fmtQty(detail.qty)}</span>],
          ["成交价格", <span key="g" className="tabular-nums text-ink">{fmtPrice(detail.price, currency, detail.market)}</span>],
          ["成交数量", (
            <span key="h" className="inline-flex items-center gap-1.5 tabular-nums text-ink">
              <span className={`h-1.5 w-1.5 flex-none rounded-full ${detail.status === "filled" ? "bg-down" : detail.status === "pending" ? "bg-[#3297f6]" : "bg-up"}`} />
              {detail.status === "filled" ? fmtQty(detail.qty) : "0"}
            </span>
          )],
          ["成交金额", <span key="i" className="font-semibold tabular-nums text-ink">{fmtMoney(detail.amount, currency)}</span>],
          ["有效期", <span key="l" className="text-ink">{validityLabel(detail)}</span>],
          ["时段", <span key="m" className="text-ink">{detail.session || "盘中+盘前盘后"}</span>],
          ["结算货币", <span key="o" className="font-mono text-ink">{currencyCode(detail.market)}</span>],
          ["订单状态", (
            <span key="p" className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              detail.status === "filled" ? "text-down" : detail.status === "pending" ? "text-[#3297f6] dark:text-[#6cb6ff]" : "text-up"
            }`}>
              <span className={`flex h-4 w-4 flex-none items-center justify-center rounded-full text-white ${
                detail.status === "filled" ? "bg-down" : detail.status === "pending" ? "bg-[#3297f6]" : "bg-up"
              }`}>
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                  {detail.status === "filled"
                    ? <path d="m2.5 6.4 2.4 2.4 4.7-5.4" />
                    : detail.status === "pending"
                      ? <><path d="M6 3v3.4l2 1.4" /><circle cx="6" cy="6" r="3.4" strokeWidth="1.6" /></>
                      : <path d="M3 3l6 6M9 3l-6 6" />}
                </svg>
              </span>
              {STATUS_LABEL[detail.status] ?? "已撤销"}
            </span>
          )],
          ["触发状态", <span key="q" className="text-ink">{detail.triggerStatus || "—"}</span>],
          ["委托时间", <span key="n" className="tabular-nums text-ink">{formatOrderTime(detail.tradedAt, detail.market)}</span>],
          ["已实现盈亏", (
            <span key="j" className={`font-semibold tabular-nums ${detail.realizedPnl == null ? "text-faint" : detail.realizedPnl >= 0 ? "text-up" : "text-down"}`}>
              {detail.realizedPnl == null ? "—" : `${detail.realizedPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(detail.realizedPnl), currency)}`}
            </span>
          )],
          ["成交后持仓", (
            <span key="k" className="tabular-nums text-ink">
              {fmtQty(detail.positionQtyAfter)}
              <span className="ml-1 text-[11px] text-faint">@ {detail.positionCostAfter == null ? "—" : fmtPrice(detail.positionCostAfter, currency)}</span>
            </span>
          )],
          ["驳回原因", <span key="r" className="text-ink">{detail.status === "cancelled" ? "订单已撤销" : "—"}</span>],
          ["备注", <span key="s" className="text-ink">{detail.note || "—"}</span>]
        ];
        return (
          <div className="fixed inset-0 z-[9999] flex items-start justify-center p-6 pt-[10vh]">
            <div className="absolute inset-0 bg-black/40" onClick={() => setDetailOrder(null)} />
            <div className="relative max-h-[80vh] w-full max-w-[440px] overflow-y-auto rounded-[18px] border border-edge bg-white shadow-pop dark:bg-[#1c1c1e]">
              <div className="flex items-center justify-between gap-2 border-b border-edge px-5 py-4">
                <div>
                  <h3 className="text-base font-bold text-ink">{detail.side === "buy" ? "买入" : detail.side === "sell" ? "卖出" : "股息"}订单详情</h3>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="relative flex-none">
                      {icon ? <img src={icon} alt="" className="h-7 w-7 rounded-full object-cover" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-gray text-xs font-bold text-muted">{detail.name.slice(0, 1)}</span>}
                      <EtfDoubleBadge market={detail.market} code={detail.code} name={detail.name} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{detail.name}</p>
                      <p className="truncate text-[11px] text-faint">{detail.code} · {meta.label} · {currency}</p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailOrder(null)}
                  aria-label="关闭"
                  className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
              <div className="px-5 py-4">
                <div className="space-y-3.5">
                  {rows.map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-4 text-xs">
                      <span className="flex-none text-muted">{label}</span>
                      <span className="min-w-0 text-right">{value}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-5 border-t border-edge pt-4">
                  <p className="text-xs font-bold text-ink">费用明细</p>
                  <div className="mt-3 space-y-3.5 text-xs">
                    <div className="flex items-center justify-between gap-4"><span className="flex-none text-muted">佣金</span><span className="tabular-nums text-ink">{fmtMoney(detail.fees, currency)}</span></div>
                    <div className="flex items-center justify-between gap-4"><span className="flex-none font-semibold text-ink">合计</span><span className="font-semibold tabular-nums text-ink">{fmtMoney(detail.fees, currency)}</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </Wrapper>
  );
}
