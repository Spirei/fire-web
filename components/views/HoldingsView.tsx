"use client";

import { sharedRead } from "@/lib/sharedRead";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtMoney, fmtMoneyCompact, fmtPct, fmtPrice, fmtQty } from "@/lib/format";
import {
  MARKET_LIST,
  FALLBACK_RATES,
  marketMeta,
  type GroupConfig,
  type MarketOption,
  type Quote,
  type RecordInput,
  type SearchMatch,
  type StockRecord,
  type TradeOrder,
  type OrderSide
} from "@/lib/types";
import { readCachedRates, writeCachedRates } from "@/lib/ratesCache";
import StockSearch from "@/components/StockSearch";
import MarketIcon from "@/components/MarketIcon";
import GroupSelect from "@/components/GroupSelect";
import MarketSelect from "@/components/MarketSelect";
import AppModal from "@/components/AppModal";
import { appConfirm } from "@/lib/appDialog";
import CurrencySelect from "@/components/CurrencySelect";
import { CURRENCY_SYMBOLS, useCurrencyDisplayUnit, useDisplayCurrency } from "@/lib/currencyPrefs";
import type { CurrencyCode } from "@/lib/currencyPrefs";
import { emptyFundBalances } from "@/lib/fundCurrencies";
import { showToast } from "@/lib/toast";
import { useAssetIcons } from "@/lib/useAssetIcons";
import HoldingsPnlSankey, { type PnlSankeyItem } from "@/components/HoldingsPnlSankey";
import { marketSessionState } from "@/lib/marketSessions";
import { useHoldingColumns } from "@/components/HoldingColumnManager";
import QuoteSourceBadge, { QuoteRowHint } from "@/components/QuoteSourceBadge";
import { HOLDING_COLUMN_LABELS, type HoldingColumnKey } from "@/lib/holdingColumns";
import TradeOrdersPanel from "@/components/TradeOrdersPanel";
import RefreshButton from "@/components/RefreshButton";
import DeleteIcon from "@/components/DeleteIcon";
import ImportSnapshotModal from "@/components/ImportSnapshotModal";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";

interface Props {
  records: StockRecord[];
  quotes: Record<string, Quote>;
  livePrice: (r: StockRecord) => number;
  refreshQuotes?: (options?: { force?: boolean }) => Promise<void>;
  onAddMatch: (match: SearchMatch) => Promise<boolean>;
  onUpdate: (id: string, input: RecordInput) => Promise<boolean>;
  onRemove: (r: StockRecord) => void;
  groups: GroupConfig[];
  markets: string[];
  marketLabels: { key: string; label: string; flag: string }[];
  marketOptions: MarketOption[];
  onMarketsChange?: (markets: string[], labels: { key: string; label: string; flag: string }[]) => void;
  onOrdersChanged?: () => void;
  initialFundBalances: Record<string, number>;
  valuationReady: boolean;
}

const PAGE_SIZE = 6;
type SortKey = "name" | "price" | "dayPnl" | "dayPnlRate" | "cost" | "qty" | "mv" | "pnl" | "rate" | "weight";
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
const SORT_STORAGE_KEY = "fire:holdings:sort";
const SORT_KEYS: SortKey[] = ["name", "price", "dayPnl", "dayPnlRate", "cost", "qty", "mv", "pnl", "rate", "weight"];
const HOLDING_SORT_KEYS: Record<HoldingColumnKey, SortKey> = {
  identity: "name",
  marketValue: "mv",
  cost: "cost",
  price: "price",
  qty: "qty",
  dayPnl: "dayPnl",
  dayPnlRate: "dayPnlRate",
  pnl: "pnl",
  pnlRate: "rate",
  weight: "weight"
};

function loadSavedSort(): SortState | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SortState>;
    if (parsed && SORT_KEYS.includes(parsed.key as SortKey) && (parsed.dir === "asc" || parsed.dir === "desc")) {
      return { key: parsed.key as SortKey, dir: parsed.dir };
    }
  } catch {
    /* 无效的本地排序配置忽略 */
  }
  return null;
}

interface EditorRow {
  key: string;
  label: string;
  flag: string;
  active: boolean;
}

function SortTh({
  dataColumn,
  label,
  align,
  k,
  sort,
  onSort
}: {
  dataColumn?: string;
  label: string;
  align: "left" | "right";
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" } | null;
  onSort: (k: SortKey) => void;
}) {
  const active = sort?.key === k;
  const up = active && sort!.dir === "asc";
  return (
    <th data-mobile-column={dataColumn} className={`px-4 py-[13px] ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        title="点击排序"
        className={`inline-flex select-none items-center gap-1 transition-colors ${align === "right" ? "flex-row-reverse" : ""} ${active ? "text-brand-deep" : "hover:text-ink"}`}
      >
        {label}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`h-3 w-3 ${active ? "opacity-100" : "opacity-25"}`}>
          {up ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
        </svg>
      </button>
    </th>
  );
}

export default function HoldingsView({ records, quotes, livePrice, refreshQuotes, onAddMatch, onUpdate, onRemove, groups, markets, marketLabels, marketOptions, onMarketsChange, onOrdersChanged, initialFundBalances, valuationReady }: Props) {
  const { brokerIcons, stockIcons, assetIcons } = useAssetIcons(["broker", "stock", "crypto", "metal"]);
  const { columns: holdingColumns } = useHoldingColumns();
  const enabledHoldingColumns = holdingColumns.filter((column) => column.visible);
  const [sessionNow, setSessionNow] = useState(() => new Date());
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);
  const positions = useMemo(() => records.filter((r) => Number(r.qty) > 0), [records]);
  // 账户资产只展示：有数量的持仓 + 从本页添加的待填记录（自选股页添加的不混入）
  const holdingsPool = useMemo(
    () => records.filter((r) => Number(r.qty) > 0 || r.source === "holdings"),
    [records]
  );

  // 行情在休市后会停止轮询，但结算状态仍需在交易所当地结算点自动推进。
  // 这只更新本地会话时钟，不会触发任何行情请求。
  useEffect(() => {
    const syncSessionClock = () => setSessionNow(new Date());
    const timer = window.setInterval(syncSessionClock, 15_000);
    window.addEventListener("focus", syncSessionClock);
    document.addEventListener("visibilitychange", syncSessionClock);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncSessionClock);
      document.removeEventListener("visibilitychange", syncSessionClock);
    };
  }, []);

  // 空市场标签自动隐藏：设置里的 markets 只负责市场顺序，标签只为「有持仓 / 本页
  // 添加记录」的市场显示（与自选股「空分组自动隐藏」一致）；某市场有记录后标签自动出现。
  const hasMarketRecords = useCallback(
    (market: string) => holdingsPool.some((p) => p.market === market),
    [holdingsPool]
  );

  const baseTabs = useMemo(() => {
    const list: string[] = [];
    markets.forEach((m) => {
      if (m && !list.includes(m) && hasMarketRecords(m)) list.push(m);
    });
    // 有持仓或本页添加记录的市场显示
    holdingsPool.forEach((p) => {
      if (p.market && !list.includes(p.market)) list.push(p.market);
    });
    return list;
  }, [markets, holdingsPool, hasMarketRecords]);

  const [tabOverride, setTabOverride] = useState<string[] | null>(null);
  const [labels, setLabels] = useState<Record<string, { label: string; flag: string }>>(() => {
    const map: Record<string, { label: string; flag: string }> = {};
    marketLabels.forEach((l) => {
      map[l.key] = { label: l.label, flag: l.flag };
    });
    return map;
  });
  const labelFor = (m: string) => m === "US" ? "美股" : labels[m]?.label || marketMeta(m).label;
  const flagFor = (m: string) => labels[m]?.flag || marketMeta(m).flag;

  const displayedTabs = useMemo(() => {
    const merged = tabOverride ? [...tabOverride, ...baseTabs.filter((m) => !tabOverride.includes(m))] : baseTabs;
    return merged.filter((m) => hasMarketRecords(m));
  }, [tabOverride, baseTabs, hasMarketRecords]);
  // 服务端与客户端首帧统一为总资产；URL 中的市场在绘制前恢复，避免刷新时先渲染
  // 第一个市场并暂时隐藏“显示货币 / 市场盈亏”。
  const [active, setActive] = useState<string>("TOTAL");
  useLayoutEffect(() => {
    setActive(new URLSearchParams(window.location.search).get("market") || "TOTAL");
  }, []);
  const dragIndex = useRef<number | null>(null);

  // URL 同步市场标签：刷新保持当前市场
  useEffect(() => {
    function syncFromUrl() {
      const m = new URLSearchParams(window.location.search).get("market");
      if (m) setActive(m);
    }
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("market") !== active) {
      sp.set("market", active);
      window.history.replaceState(null, "", `?${sp.toString()}`);
    }
  }, [active]);

  useEffect(() => {
    if (active !== "TOTAL" && !displayedTabs.includes(active)) setActive(displayedTabs[0] ?? "TOTAL");
  }, [displayedTabs, active]);

  const [page, setPage] = useState(1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorRows, setEditorRows] = useState<EditorRow[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newMarket, setNewMarket] = useState({ key: "", label: "", flag: "" });
  const [added, setAdded] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [editRecord, setEditRecord] = useState<StockRecord | null>(null);
  const [editForm, setEditForm] = useState({ name: "", market: "", price: "", cost: "", qty: "", group: "", note: "" });
  const [editSaving, setEditSaving] = useState(false);
  const [selectedHolding, setSelectedHolding] = useState<StockRecord | null>(null);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [tradeRecord, setTradeRecord] = useState<StockRecord | null>(null);
  const [editingOrder, setEditingOrder] = useState<TradeOrder | null>(null);
  const [tradeSide, setTradeSide] = useState<OrderSide>("buy");
  const [tradeSaving, setTradeSaving] = useState(false);
  const [tradeForm, setTradeForm] = useState({ qty: "", price: "", fees: "0", tradedAt: "", note: "" });
  // 汇率：初始用兜底值（避免刷新瞬间非美元市场被按 1:1 误算）。
  // ⚠️ 缓存必须在挂载后才读：首帧读 localStorage 会让服务端与客户端渲染出不同金额（hydration 报错）。
  const [rates, setRates] = useState<Record<string, number>>(() => ({ ...FALLBACK_RATES }));
  // 是否有「上一次成功」的汇率：有则秒开真实值；没有则不展示猜测值，等服务端返回
  const [ratesReady, setRatesReady] = useState(false);
  const [fundBalances, setFundBalances] = useState<Record<string, number>>(() => ({ ...emptyFundBalances(), ...initialFundBalances }));
  const { currency: displayCur, setCurrency: setDisplayCur } = useDisplayCurrency();
  const { unit: currencyDisplayUnit } = useCurrencyDisplayUnit();
  // 市场盈亏卡片拖动顺序（本地记忆）
  const [pnlOrder, setPnlOrder] = useState<string[]>([]);
  // 浏览器缓存（汇率 + 市场盈亏卡片顺序）统一在挂载后、绘制前恢复，避免水合不一致与闪烁
  useLayoutEffect(() => {
    const cachedRates = readCachedRates();
    if (cachedRates) {
      setRates((prev) => ({ ...prev, ...cachedRates }));
      setRatesReady(true);
    }
    try {
      const savedOrder = JSON.parse(localStorage.getItem("fire:holdings:pnl-order") || "null");
      if (Array.isArray(savedOrder)) setPnlOrder(savedOrder);
    } catch {
      /* 忽略 */
    }
  }, []);
  const pnlDragIndex = useRef<number | null>(null);

  // 加载实时汇率（总资产跨市场换算用）；抽成函数供手动刷新复用
  const loadRates = useCallback(async () => {
    try {
      const res = await sharedRead("/api/rates");
      const data = res.ok ? await res.json() : null;
      if (data?.rates) {
        // 以当前（上一次成功）汇率为底，覆盖上游返回的币种，缺失币种保留上次值
        setRates((prev) => ({ ...prev, ...data.rates, USD: 1 }));
        setRatesReady(true);
        writeCachedRates(data.rates);
      }
    } catch {
      /* 汇率失败保留上次值 */
    }
  }, []);

  useEffect(() => {
    void loadRates();
  }, [loadRates]);

  const loadFundBalances = useCallback(async () => {
    try {
      const res = await sharedRead("/api/v1/funds?limit=1");
      const json = res.ok ? await res.json() : null;
      if (json?.data?.balances) setFundBalances((current) => ({ ...current, ...json.data.balances }));
    } catch {
      /* 资金服务异常时保留上一次余额，避免总资产闪回持仓市值 */
    }
  }, []);

  useEffect(() => {
    void loadFundBalances();
    const refresh = () => void loadFundBalances();
    window.addEventListener("fire:orders-updated", refresh);
    window.addEventListener("fire:records-updated", refresh);
    return () => {
      window.removeEventListener("fire:orders-updated", refresh);
      window.removeEventListener("fire:records-updated", refresh);
    };
  }, [loadFundBalances]);

  const refreshAccount = useCallback(async () => {
    await Promise.allSettled([loadRates(), loadFundBalances(), refreshQuotes?.({ force: true }) ?? Promise.resolve()]);
    showToast("已刷新账户资产");
  }, [loadRates, loadFundBalances, refreshQuotes]);

  const toUsd = (m: string, value: number) => {
    // 市场 → ISO 货币代码（marketMeta.currency 是符号，不能直接查汇率）
    const iso: Record<string, string> = { HK: "HKD", US: "USD", CN: "CNY", JP: "JPY", KR: "KRW" };
    const r = rates[iso[m] ?? "USD"] ?? 1;
    return r > 0 ? value / r : value;
  };

  // 列表显示该市场全部记录（含未填数量的待持仓股票）；总资产视图显示全部持仓
  const filtered = useMemo(
    () => (active === "TOTAL" ? positions : holdingsPool.filter((p) => p.market === active)),
    [holdingsPool, positions, active]
  );
  const filteredMarketValue = useMemo(() => filtered.reduce((sum, record) => {
    const factor = active === "TOTAL" ? toUsd(record.market, 1) : 1;
    return sum + livePrice(record) * (Number(record.qty) || 0) * factor;
  }, 0), [filtered, active, livePrice, rates]);
  const [sort, setSort] = useState<SortState | null>(null);

  useEffect(() => {
    const saved = loadSavedSort();
    if (saved) setSort(saved);
  }, []);

  function sortValue(r: StockRecord, key: SortKey): number | string | null {
    const qty = Number(r.qty);
    const price = livePrice(r);
    const cost = Number(r.cost);
    const quote = quotes[r.id];
    const f = active === "TOTAL" ? toUsd(r.market, 1) : 1;
    switch (key) {
      case "name": return r.name;
      case "price": return price;
      case "dayPnl": return quote ? quote.change * qty * f : null;
      case "dayPnlRate": return quote ? quote.changePct : null;
      case "cost": return Number.isFinite(cost) ? cost * f : null;
      case "qty": return qty;
      case "mv": return price * qty * f;
      case "pnl": return Number.isFinite(cost) ? (price - cost) * qty * f : null;
      case "rate": return cost !== 0 && Number.isFinite(cost) ? (price - cost) / cost : null;
      case "weight": return filteredMarketValue ? price * qty * f / filteredMarketValue : 0;
    }
  }

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb, "zh-CN") * dir;
      }
      const na = va === null ? null : Number(va);
      const nb = vb === null ? null : Number(vb);
      if (na === null && nb === null) return 0;
      if (na === null) return 1;
      if (nb === null) return -1;
      return (na - nb) * dir;
    });
  }, [filtered, sort, livePrice, quotes, rates, filteredMarketValue]);

  const metrics = useMemo(() => {
    let mv = 0;
    let cost = 0;
    let pnl = 0;
    let day = 0;
    filtered.forEach((r) => {
      const qty = Number(r.qty);
      const price = livePrice(r);
      const factor = active === "TOTAL" ? toUsd(r.market, 1) : 1;
      mv += price * qty * factor;
      const c = Number(r.cost);
      if (c) {
        cost += c * qty * factor;
        pnl += (price - c) * qty * factor;
      }
      const q = quotes[r.id];
      if (q) day += q.change * qty * factor;
    });
    return { mv, cost, pnl, day, rate: cost ? pnl / cost : null };
  }, [filtered, livePrice, quotes, active, rates]);
  // 只有完整持仓行情快照恢复后才展示估值，禁止首屏把“仅现金”或数据库旧价当成总资产。
  const metricsReady = valuationReady;
  // 总资产视图：市场盈亏汇总
  const marketPnl = useMemo(() => {
    const map = new Map<string, { mv: number; cost: number; pnl: number; day: number }>();
    positions.forEach((r) => {
      const qty = Number(r.qty);
      const price = livePrice(r);
      const e = map.get(r.market) ?? { mv: 0, cost: 0, pnl: 0, day: 0 };
      // 各市场按本币统计（汇总换算在总资产指标卡中统一处理）
      e.mv += price * qty;
      const c = Number(r.cost);
      if (c) {
        e.cost += c * qty;
        e.pnl += (price - c) * qty;
      }
      const q = quotes[r.id];
      if (q) e.day += q.change * qty;
      map.set(r.market, e);
    });
    return [...map.entries()];
  }, [positions, livePrice, quotes]);

  const pnlSankey = useMemo(() => {
    const rows: PnlSankeyItem[] = positions.flatMap((record) => {
      const cost = Number(record.cost);
      const qty = Number(record.qty);
      if (!(cost > 0) || !(qty > 0)) return [];
      const pnl = toUsd(record.market, (livePrice(record) - cost) * qty);
      if (!Number.isFinite(pnl) || pnl === 0) return [];
      return [{ name: record.name, code: record.code, market: record.market, pnl }];
    });
    const top = (kind: "profit" | "loss") => rows
      .filter((item) => (kind === "profit" ? item.pnl > 0 : item.pnl < 0))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
      .slice(0, 6);
    return {
      profit: top("profit"),
      loss: top("loss"),
      profitTotal: rows.reduce((sum, item) => sum + (item.pnl > 0 ? item.pnl : 0), 0),
      lossTotal: rows.reduce((sum, item) => sum + (item.pnl < 0 ? Math.abs(item.pnl) : 0), 0)
    };
  }, [positions, livePrice, rates]);

  // 按拖动顺序排列各市场卡片
  const orderedPnl = useMemo(() => {
    const items = [...marketPnl];
    if (pnlOrder.length > 0) {
      items.sort((a, b) => {
        const ia = pnlOrder.indexOf(a[0]);
        const ib = pnlOrder.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
    }
    return items;
  }, [marketPnl, pnlOrder]);

  function dropPnlCard(to: number) {
    if (pnlDragIndex.current === null) return;
    const from = pnlDragIndex.current;
    pnlDragIndex.current = null;
    if (from === to) return;
    const next = [...orderedPnl];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    const order = next.map(([m]) => m);
    setPnlOrder(order);
    try {
      localStorage.setItem("fire:holdings:pnl-order", JSON.stringify(order));
    } catch {
      /* 忽略存储异常 */
    }
  }

  const cur = active === "TOTAL" ? "USD" : marketMeta(active).currency || "USD";
  // 总资产视图：显示货币换算系数（1 USD = rates[displayCur]）
  const totalFactor = active === "TOTAL" ? (rates[displayCur] ?? 1) : 1;
  const totalCur = active === "TOTAL" ? displayCur : cur;
  // 总资产货币符号（ISO 码 → 符号；市场盈亏卡片仍用 USD$/HKD$/CNY¥ 规范标识）
  const totalCurLabel = CURRENCY_SYMBOLS[totalCur as keyof typeof CURRENCY_SYMBOLS] || totalCur;
  const cashInUsd = useMemo(() => (Object.entries(fundBalances) as [string, number][]).reduce((sum, [iso, value]) => sum + value / (rates[iso] || 1), 0), [fundBalances, rates]);
  const displayedNetAsset = active === "TOTAL"
    ? (metrics.mv + cashInUsd) * totalFactor
    : metrics.mv + (fundBalances[(Object.entries({ US: "USD", HK: "HKD", CN: "CNY", JP: "JPY", KR: "KRW", SG: "SGD" }).find(([market]) => market === active)?.[1] || "USD")] || 0);
  const pageUsesCompactMoney = useMemo(() => {
    const values = [
    displayedNetAsset,
    metrics.mv * totalFactor,
    metrics.pnl * totalFactor,
    metrics.day * totalFactor
    ];
    const max = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
    return currencyDisplayUnit === "compact" || (currencyDisplayUnit === "auto" && max >= 1e7);
  }, [displayedNetAsset, metrics, totalFactor, currencyDisplayUnit]);
  const compactMoney = useCallback((value: number, currency: string) => pageUsesCompactMoney ? fmtMoneyCompact(value, currency) : fmtMoney(value, currency), [pageUsesCompactMoney]);

  const recordMarketOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: MarketOption[] = [];
    marketOptions.forEach((o) => {
      if (!seen.has(o.key)) {
        seen.add(o.key);
        opts.push(o);
      }
    });
    positions.forEach((p) => {
      if (!seen.has(p.market)) {
        seen.add(p.market);
        opts.push({ key: p.market, label: labelFor(p.market), flag: flagFor(p.market) });
      }
    });
    return opts;
  }, [marketOptions, positions, labels]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function switchMarket(m: string) {
    setActive(m);
    setPage(1);
    setEditorOpen(false);
  }

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      let next: SortState | null;
      if (!prev || prev.key !== key) {
        next = { key, dir: key === "name" ? "asc" : "desc" };
      } else if (prev.dir === "desc") {
        next = { key, dir: "asc" };
      } else {
        next = null;
      }
      try {
        if (next) {
          localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next));
        } else {
          localStorage.removeItem(SORT_STORAGE_KEY);
        }
      } catch {
        /* 忽略存储异常 */
      }
      return next;
    });
  }

  function holdingColumnCell(record: StockRecord, key: HoldingColumnKey) {
    const meta = marketMeta(record.market);
    const qty = Number(record.qty) || 0;
    const price = livePrice(record);
    const marketValue = qty > 0 ? price * qty : null;
    const cost = Number(record.cost);
    const hasCost = Number.isFinite(cost);
    const costValue = hasCost ? cost * qty : null;
    const pnl = marketValue !== null && costValue !== null ? marketValue - costValue : null;
    const pnlRate = pnl !== null && cost !== 0 ? pnl / costValue! : null;
    const quote = quotes[record.id];
    const dayPnl = qty > 0 && quote ? quote.change * qty : null;
    const dayPnlRate = quote ? quote.changePct / 100 : null;
    const factor = active === "TOTAL" ? toUsd(record.market, 1) : 1;
    const displayMoneyFactor = active === "TOTAL" ? factor * (rates[displayCur] ?? 1) : 1;
    const displayMoneyCurrency = active === "TOTAL" ? totalCurLabel : meta.currency;
    const weight = marketValue !== null && filteredMarketValue ? marketValue * factor / filteredMarketValue : null;

    if (key === "identity") {
      const icon = record.market.toUpperCase() === "ASSET" ? assetIcons[record.code.toUpperCase()] : stockIcons[`${record.market.toUpperCase()}:${record.code.toUpperCase()}`];
      return <button type="button" onClick={() => openHoldingDetail(record)} className="group flex min-w-[180px] max-w-full items-center gap-2.5 text-left" title={`查看 ${record.name} 持仓概览与订单`}>
        <span className="relative flex-none">
          {icon ? <img src={icon} alt="" className="h-9 w-9 rounded-full object-cover" /> : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-gray text-xs font-bold text-muted">{(record.name || "?").slice(0, 1)}</span>}
          <EtfDoubleBadge market={record.market} code={record.code} name={record.name} />
        </span>
        <span className="min-w-0"><span className="block truncate font-semibold text-ink transition-colors group-hover:text-brand-deep dark:group-hover:text-[#c6cdd8]">{record.name}</span><span className="mt-0.5 flex min-w-0 items-center gap-1.5"><MarketCodeBadge market={record.market} code={record.code} /><span className="truncate text-[11px] text-faint">{record.code}</span><QuoteRowHint market={record.market} quote={quote} quotes={quotes} /></span></span>
      </button>;
    }
    if (key === "marketValue") return marketValue !== null ? <span className="font-semibold">{compactMoney(marketValue * displayMoneyFactor, displayMoneyCurrency)}</span> : <span className="text-faint">—</span>;
    if (key === "cost") return hasCost ? fmtPrice(cost, meta.currency, record.market) : "—";
    if (key === "price") return <><div className="font-semibold">{fmtPrice(price, meta.currency, record.market)}</div>{quote && <div className={`text-xs font-semibold ${quote.changePct >= 0 ? "text-up" : "text-down"}`}>{quote.changePct >= 0 ? "+" : ""}{fmtPct(quote.changePct / 100)}</div>}</>;
    if (key === "qty") return qty > 0 ? fmtQty(qty) : <button type="button" onClick={() => openEdit(record)} className="rounded-full bg-brand-light px-2 py-0.5 text-[11px] font-semibold text-brand-deep transition-colors hover:bg-brand-hover">待填数量</button>;
    if (key === "dayPnl") return dayPnl !== null ? <span className={`font-semibold ${dayPnl >= 0 ? "text-up" : "text-down"}`}>{dayPnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(dayPnl * displayMoneyFactor), displayMoneyCurrency)}</span> : <span className="text-faint">—</span>;
    if (key === "dayPnlRate") return dayPnlRate !== null ? <span className={`font-semibold ${dayPnlRate >= 0 ? "text-up" : "text-down"}`}>{dayPnlRate >= 0 ? "+" : ""}{fmtPct(dayPnlRate)}</span> : <span className="text-faint">—</span>;
    if (key === "pnl") return pnl !== null ? <span className={`font-semibold ${pnl >= 0 ? "text-up" : "text-down"}`}>{pnl >= 0 ? "+" : "−"}{compactMoney(Math.abs(pnl * displayMoneyFactor), displayMoneyCurrency)}</span> : <span className="text-faint">—</span>;
    if (key === "pnlRate") return pnlRate !== null ? <span className={`font-semibold ${pnlRate >= 0 ? "text-up" : "text-down"}`}>{pnlRate >= 0 ? "+" : ""}{fmtPct(pnlRate)}</span> : <span className="text-faint">—</span>;
    return weight !== null ? <span className="font-semibold">{fmtPct(weight)}</span> : <span className="text-faint">—</span>;
  }

  async function persistTabs(list: string[]) {
    setTabOverride(list);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markets: list })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      onMarketsChange?.(
        list,
        Object.entries(labels).map(([key, v]) => ({ key, label: v.label, flag: v.flag }))
      );
      showToast("市场顺序已更新");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    }
  }

  function onDropTab(to: number) {
    if (dragIndex.current === null) return;
    const from = dragIndex.current;
    dragIndex.current = null;
    if (from === to) return;
    const list = [...displayedTabs];
    const [m] = list.splice(from, 1);
    list.splice(to, 0, m);
    persistTabs(list);
  }

  function openEditor() {
    const seen = new Set<string>();
    const rows: EditorRow[] = [];
    const push = (key: string) => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      rows.push({ key, label: labelFor(key), flag: flagFor(key), active: displayedTabs.includes(key) });
    };
    displayedTabs.forEach(push);
    positions.forEach((p) => push(p.market));
    MARKET_LIST.forEach(push);
    marketOptions.forEach((o) => push(o.key));
    Object.keys(labels).forEach(push);
    setEditorRows(rows);
    setEditingKey(null);
    setNewMarket({ key: "", label: "", flag: "" });
    setEditorOpen(true);
  }

  function updateRow(key: string, patch: Partial<EditorRow>) {
    setEditorRows((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  function addMarket() {
    const key = newMarket.key.trim();
    const label = newMarket.label.trim() || key;
    const flag = "";
    if (!key) {
      showToast("请输入市场代码（如 SG / CA / GB）", "err");
      return;
    }
    if (editorRows.some((r) => r.key.toLowerCase() === key.toLowerCase())) {
      showToast("该市场已存在", "err");
      return;
    }
    setEditorRows((prev) => [...prev, { key, label, flag, active: true }]);
    setNewMarket({ key: "", label: "", flag: "" });
    showToast(`已新增市场 ${label}`);
  }

  async function saveMarketEditor() {
    const ordered = editorRows.filter((r) => r.active).map((r) => r.key);
    if (ordered.length === 0) {
      showToast("至少保留一个显示市场", "err");
      return;
    }
    const labelsArr = editorRows
      .filter((r) => r.label.trim() !== marketMeta(r.key).label || r.flag.trim() !== marketMeta(r.key).flag)
      .map((r) => ({ key: r.key, label: r.label.trim() || marketMeta(r.key).label, flag: r.flag.trim() || marketMeta(r.key).flag }));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markets: ordered, marketLabels: labelsArr })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      const map: Record<string, { label: string; flag: string }> = {};
      (data.settings.marketLabels ?? []).forEach((l: { key: string; label: string; flag: string }) => {
        map[l.key] = { label: l.label, flag: l.flag };
      });
      setLabels(map);
      onMarketsChange?.(ordered, labelsArr);
      setTabOverride(ordered);
      setEditorOpen(false);
      setPage(1);
      if (!ordered.includes(active)) setActive(ordered[0] ?? "US");
      showToast("市场设置已保存");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    }
  }

  async function handleSelect(m: SearchMatch) {
    const ok = await onAddMatch(m);
    if (ok) {
      // 自动切换到该股票所属的市场标签，方便直接填写数量
      setActive(m.market);
      setPage(1);
      setAdded(`${m.name} 已加入，自动归入 ${labelFor(m.market)} 市场`);
      setTimeout(() => setAdded(""), 3500);
    }
  }

  function openEdit(r: StockRecord) {
    setEditRecord(r);
    setEditForm({
      name: r.name,
      market: r.market,
      price: String(r.price ?? ""),
      cost: String(r.cost ?? ""),
      qty: String(r.qty ?? ""),
      group: r.group ?? "",
      note: r.note ?? ""
    });
  }

  async function saveEdit() {
    if (!editRecord) return;
    setEditSaving(true);
    const toNum = (s: string) => (s.trim() === "" ? "" : Number(s.trim()));
    const input: RecordInput = {
      name: editForm.name.trim() || editRecord.name,
      code: editRecord.code,
      market: editForm.market || editRecord.market,
      price: toNum(editForm.price),
      cost: toNum(editForm.cost),
      qty: toNum(editForm.qty),
      group: editForm.group.trim(),
      note: editForm.note.trim()
    };
    const ok = await onUpdate(editRecord.id, input);
    setEditSaving(false);
    if (ok) {
      setEditRecord(null);
      showToast("保存成功");
    }
  }

  const loadOrders = async (recordId = selectedHolding?.id) => {
    if (!recordId) return;
    setOrdersLoading(true);
    try {
      const res = await fetch(`/api/v1/orders?scope=all&recordId=${encodeURIComponent(recordId)}&limit=500`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.code !== 0) throw new Error(data?.message || "订单加载失败");
      setOrders(Array.isArray(data?.data?.orders) ? data.data.orders : []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "订单加载失败", "err");
    } finally {
      setOrdersLoading(false);
    }
  };

  async function deleteHoldingOrder(order: TradeOrder) {
    if (!selectedHolding) return;
    if (!await appConfirm(`确定删除 ${new Date(order.tradedAt).toLocaleString("zh-CN", { hour12: false })} 的这笔${order.side === "buy" ? "买入" : "卖出"}订单吗？\n\n删除后会自动重算该股票的持仓和后续订单，且无法撤销。`, { title: "删除订单", danger: true })) return;
    setDeletingOrderId(order.id);
    try {
      const res = await fetch(`/api/v1/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.code !== 0) throw new Error(data?.message || "删除失败");
      const nextPosition = data?.data?.position;
      if (nextPosition && selectedHolding.id === order.recordId) setSelectedHolding({ ...selectedHolding, qty: nextPosition.qty || "", cost: nextPosition.cost ?? "" });
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:orders-updated"));
      onOrdersChanged?.();
      await loadOrders(selectedHolding.id);
      showToast("订单已删除，持仓与后续订单已重新计算");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "err");
    } finally {
      setDeletingOrderId(null);
    }
  }

  useEffect(() => {
    if (selectedHolding) void loadOrders(selectedHolding.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHolding?.id]);

  useEffect(() => {
    function syncHoldingFromUrl() {
      const symbol = new URLSearchParams(window.location.search).get("symbol");
      if (!symbol) {
        setSelectedHolding(null);
        return;
      }
      const match = /^([A-Z]{2,5})[:.-](.+)$/i.exec(symbol);
      if (!match) return;
      const market = match[1].toUpperCase();
      const code = match[2].toUpperCase();
      const holding = records.find((record) => record.market.toUpperCase() === market && record.code.toUpperCase() === code);
      if (holding) setSelectedHolding(holding);
    }
    syncHoldingFromUrl();
    window.addEventListener("popstate", syncHoldingFromUrl);
    return () => window.removeEventListener("popstate", syncHoldingFromUrl);
  }, [records]);

  function openHoldingDetail(record: StockRecord) {
    setSelectedHolding(record);
    const params = new URLSearchParams(window.location.search);
    params.set("symbol", `${record.market.toUpperCase()}.${record.code.toUpperCase()}`);
    window.history.pushState(null, "", `${window.location.pathname}?${params.toString()}`);
  }

  function backToHoldings() {
    setSelectedHolding(null);
    const params = new URLSearchParams(window.location.search);
    params.delete("symbol");
    const query = params.toString();
    window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }

  function openTrade(record: StockRecord, side: OrderSide) {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    setTradeRecord(record);
    setEditingOrder(null);
    setTradeSide(side);
    setTradeForm({
      qty: side === "dividend" && Number(record.qty) > 0 ? String(record.qty) : "",
      price: side === "dividend" ? "" : String(livePrice(record) || record.price || ""),
      fees: "0",
      tradedAt: now.toISOString().slice(0, 16),
      note: ""
    });
  }

  function openOrderEdit(order: TradeOrder) {
    const traded = new Date(order.tradedAt);
    traded.setMinutes(traded.getMinutes() - traded.getTimezoneOffset());
    setEditingOrder(order);
    setTradeRecord(selectedHolding);
    setTradeSide(order.side);
    setTradeForm({
      qty: String(order.qty),
      price: String(order.price),
      fees: String(order.fees),
      tradedAt: traded.toISOString().slice(0, 16),
      note: order.note
    });
  }

  async function submitTrade() {
    if (!tradeRecord) return;
    const qty = Number(tradeForm.qty);
    const price = Number(tradeForm.price);
    const fees = Number(tradeForm.fees || 0);
    if (!(qty > 0) || !(price > 0) || !(fees >= 0)) {
      showToast("请填写有效的成交数量、价格和费用", "err");
      return;
    }
    setTradeSaving(true);
    try {
      const res = await fetch(editingOrder ? `/api/v1/orders/${encodeURIComponent(editingOrder.id)}` : "/api/v1/orders", {
        method: editingOrder ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: tradeRecord.id,
          side: tradeSide,
          qty,
          price,
          fees,
          tradedAt: tradeForm.tradedAt ? new Date(tradeForm.tradedAt).toISOString() : undefined,
          note: tradeForm.note
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.code !== 0) throw new Error(data?.message || "成交失败");
      const corrected = !!editingOrder;
      const nextPosition = data?.data?.position;
      if (nextPosition && selectedHolding?.id === tradeRecord.id) {
        setSelectedHolding({ ...selectedHolding, qty: nextPosition.qty || "", cost: nextPosition.cost ?? "" });
      }
      setTradeRecord(null);
      setEditingOrder(null);
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:orders-updated"));
      onOrdersChanged?.();
      const sideLabel = tradeSide === "buy" ? "买入" : tradeSide === "sell" ? "卖出" : "股息";
      showToast(corrected ? "订单已更正，持仓与后续订单已重新计算" : `${sideLabel}已入账，订单已更新`);
      await loadOrders(tradeRecord.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "成交失败", "err");
    } finally {
      setTradeSaving(false);
    }
  }

  if (selectedHolding) {
    const detailQuote = quotes[selectedHolding.id] ?? null;
    const detailMeta = marketMeta(selectedHolding.market);
    const detailPrice = livePrice(selectedHolding);
    const detailQty = Number(selectedHolding.qty) || 0;
    const detailCost = Number(selectedHolding.cost);
    const detailMarketValue = detailPrice * detailQty;
    const detailCostValue = Number.isFinite(detailCost) ? detailCost * detailQty : null;
    const detailPnl = detailCostValue == null ? null : detailMarketValue - detailCostValue;
    const detailPnlRate = detailPnl == null || !detailCostValue ? null : detailPnl / Math.abs(detailCostValue);
    const detailDayPnl = detailQuote ? detailQuote.change * detailQty : null;
    const detailDisplayFactor = active === "TOTAL"
      ? toUsd(selectedHolding.market, 1) * (rates[displayCur] ?? 1)
      : 1;
    const detailDisplayCurrency = active === "TOTAL" ? totalCurLabel : detailMeta.currency;
    const detailSession = marketSessionState(selectedHolding.market, sessionNow);
    const detailIcon = selectedHolding.market.toUpperCase() === "ASSET" ? assetIcons[selectedHolding.code.toUpperCase()] : stockIcons[`${selectedHolding.market.toUpperCase()}:${selectedHolding.code.toUpperCase()}`];
    const quoteTime = (() => {
      if (!detailQuote?.time) return detailSession.localDate;
      const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(detailQuote.time.replace(/\D/g, ""));
      if (compact) return `${Number(compact[2])}月${Number(compact[3])}日 ${compact[4]}:${compact[5]}`;
      const parsed = new Date(detailQuote.time);
      if (Number.isNaN(parsed.getTime())) return detailQuote.time;
      return parsed.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    })();
    return (
      <div className="w-full max-w-[720px]" style={{ animation: "fade-in .25s ease" }}>
        <section data-testid="holding-position-summary" className="w-full overflow-hidden rounded-[20px] border border-edge bg-white shadow-sm dark:bg-[#151a26]">
          <div className="flex items-center justify-between gap-3 border-b border-edge px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <button type="button" onClick={backToHoldings} title="返回持仓" aria-label="返回持仓" className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-edge text-muted transition-colors hover:bg-bg-gray hover:text-ink">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              {detailIcon ? (
                <img src={detailIcon} alt="" className="h-11 w-11 flex-none rounded-full object-cover" />
              ) : (
                <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-bg-gray text-sm font-bold text-muted">{(selectedHolding.name || "?").slice(0, 1)}</span>
              )}
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-2">
                  <h2 className="truncate text-lg font-bold text-ink">{selectedHolding.name}</h2>
                  <MarketCodeBadge market={selectedHolding.market} code={selectedHolding.code} />
                  <span className="flex-none text-xs font-semibold text-faint">{selectedHolding.code}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span className="inline-flex items-center gap-1.5"><MarketIcon market={selectedHolding.market} flag={flagFor(selectedHolding.market)} size={16} />{detailMeta.label}</span>
                  {selectedHolding.group && <><span className="text-faint">·</span><span>{selectedHolding.group}</span></>}
                </div>
              </div>
            </div>
            <button type="button" onClick={() => openTrade(selectedHolding, "buy")} className="btn btn-line btn-sm flex-none">交易</button>
          </div>

          <div className="grid gap-4 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)]">
            <div className="flex min-h-[132px] flex-col justify-center rounded-[15px] bg-bg-gray/70 px-4 py-3.5 dark:border dark:border-edge dark:bg-[#101621]">
              <span className="text-xs font-semibold text-muted">最新价</span>
              <strong className={`mt-1 text-[30px] leading-tight tabular-nums ${detailQuote && detailQuote.change >= 0 ? "text-up" : detailQuote ? "text-down" : "text-ink"}`}>{fmtPrice(detailPrice, detailMeta.currency, selectedHolding.market)}</strong>
              {detailQuote ? (
                <span className={`mt-1.5 text-sm font-semibold tabular-nums ${detailQuote.change >= 0 ? "text-up" : "text-down"}`}>
                  {detailQuote.change >= 0 ? "+" : ""}{detailQuote.change.toFixed(2)} · {detailQuote.changePct >= 0 ? "+" : ""}{detailQuote.changePct.toFixed(2)}%
                </span>
              ) : <span className="mt-1.5 text-xs text-faint">等待实时行情</span>}
              <span className="mt-3 text-[11px] text-faint">{detailSession.label} · {quoteTime}</span>
            </div>

            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-[15px] border border-edge px-4 py-3.5">
              <div><dt className="text-[11px] text-muted">持仓市值</dt><dd className="mt-1 font-semibold tabular-nums text-ink">{compactMoney(detailMarketValue * detailDisplayFactor, detailDisplayCurrency)}</dd></div>
              <div><dt className="text-[11px] text-muted">持仓盈亏</dt><dd className={`mt-1 font-semibold tabular-nums ${detailPnl == null ? "text-faint" : detailPnl >= 0 ? "text-up" : "text-down"}`}>{detailPnl == null ? "—" : `${detailPnl >= 0 ? "+" : "−"}${compactMoney(Math.abs(detailPnl * detailDisplayFactor), detailDisplayCurrency)}`}</dd></div>
              <div><dt className="text-[11px] text-muted">当日盈亏</dt><dd className={`mt-1 font-semibold tabular-nums ${detailDayPnl == null ? "text-faint" : detailDayPnl >= 0 ? "text-up" : "text-down"}`}>{detailDayPnl == null ? "—" : `${detailDayPnl >= 0 ? "+" : "−"}${compactMoney(Math.abs(detailDayPnl * detailDisplayFactor), detailDisplayCurrency)}`}</dd></div>
              <div><dt className="text-[11px] text-muted">盈亏率</dt><dd className={`mt-1 font-semibold tabular-nums ${detailPnlRate == null ? "text-faint" : detailPnlRate >= 0 ? "text-up" : "text-down"}`}>{detailPnlRate == null ? "—" : `${detailPnlRate >= 0 ? "+" : ""}${fmtPct(detailPnlRate)}`}</dd></div>
              <div><dt className="text-[11px] text-muted">成本价</dt><dd className="mt-1 font-semibold tabular-nums text-ink">{Number.isFinite(detailCost) ? fmtPrice(detailCost, detailMeta.currency, selectedHolding.market) : "—"}</dd></div>
              <div><dt className="text-[11px] text-muted">持仓数量</dt><dd className="mt-1 font-semibold tabular-nums text-ink">{fmtQty(detailQty)}</dd></div>
            </dl>
          </div>
        </section>

        <section data-testid="holding-trade-orders" className="mt-5 w-full overflow-hidden rounded-[18px] border border-edge bg-white shadow-sm dark:bg-[#151a26]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-5 py-4">
            <div>
              <h3 className="text-base font-bold text-ink">交易与订单</h3>
              <p className="mt-1 text-xs text-muted">每笔成交生成唯一订单号并永久留痕，自动更新该股票的持仓数量与成本。</p>
            </div>
          </div>
          <TradeOrdersPanel
            bare
            orders={orders}
            stockIcons={stockIcons}
            storageKey="fire:holdings:order-tab"
            loading={ordersLoading}
            recordId={selectedHolding.id}
            onRefresh={() => loadOrders(selectedHolding.id)}
            onEdit={openOrderEdit}
            onDelete={deleteHoldingOrder}
            deletingId={deletingOrderId}
          />
        </section>

        {tradeRecord && (
          <AppModal title={`${editingOrder ? "更正订单" : "交易"} ${tradeRecord.name}`} desc={`${tradeRecord.code} · ${marketMeta(tradeRecord.market).label} · 当前持仓 ${fmtQty(tradeRecord.qty)}`} onClose={() => { setTradeRecord(null); setEditingOrder(null); }} size="md">
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-[12px] bg-bg-gray p-1">
              {(["buy", "sell", "dividend"] as OrderSide[]).map((side) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => setTradeSide(side)}
                  className={`rounded-[9px] py-2.5 text-sm font-bold transition-colors ${
                    tradeSide === side
                      ? "border border-edge-strong bg-white shadow-sm " + (side === "buy" ? "text-up" : side === "sell" ? "text-down" : "text-brand-deep")
                      : "text-muted"
                  }`}
                >
                  {side === "buy" ? "买入" : side === "sell" ? "卖出" : "股息"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3.5">
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">{tradeSide === "dividend" ? "持仓股数" : "成交数量"}<input type="number" min="0" step="any" value={tradeForm.qty} onChange={(e) => setTradeForm({ ...tradeForm, qty: e.target.value })} className="field" placeholder={tradeSide === "sell" ? `最多 ${fmtQty(tradeRecord.qty)}` : tradeSide === "dividend" ? `当前 ${fmtQty(tradeRecord.qty)}` : "0"} /></label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">{tradeSide === "dividend" ? "每股股息" : "成交价格"}<input type="number" min="0" step="0.001" value={tradeForm.price} onChange={(e) => setTradeForm({ ...tradeForm, price: e.target.value })} className="field" /></label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">交易费用<input type="number" min="0" step="0.01" value={tradeForm.fees} onChange={(e) => setTradeForm({ ...tradeForm, fees: e.target.value })} className="field" /></label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">成交时间<input type="text" inputMode="numeric" value={tradeForm.tradedAt} onChange={(e) => setTradeForm({ ...tradeForm, tradedAt: e.target.value })} className="field" placeholder="YYYY-MM-DD HH:mm" /></label>
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">订单备注<input value={tradeForm.note} onChange={(e) => setTradeForm({ ...tradeForm, note: e.target.value })} className="field" placeholder="如：分批建仓、止盈、调仓" /></label>
            </div>
            <div className="mt-4 rounded-[12px] border border-edge bg-bg-gray/60 px-4 py-3 text-xs text-muted">股息总额：<strong className="text-ink">{fmtMoney((Number(tradeForm.qty) || 0) * (Number(tradeForm.price) || 0), marketMeta(tradeRecord.market).currency)}</strong>{tradeSide === "dividend" ? " · 按持仓股数 × 每股股息记为现金收入，计入已实现收益，不改变持仓数量与成本" : tradeSide === "buy" ? " · 买入后按含费用的加权成本更新" : " · 卖出回款冲减投入并摊薄剩余成本，费用计入已实现盈亏"}</div>
            {editingOrder && <p className="mt-3 text-xs leading-relaxed text-muted">更正后将按成交时间重新计算该股票全部订单；若中途出现超卖，系统会拒绝保存。</p>}
            <div className="mt-5 flex justify-end gap-2.5"><button type="button" onClick={() => { setTradeRecord(null); setEditingOrder(null); }} className="btn btn-ghost btn-sm">取消</button><button type="button" disabled={tradeSaving} onClick={() => void submitTrade()} className="btn btn-line btn-sm disabled:opacity-60">{tradeSaving ? (editingOrder ? "保存中…" : "成交中…") : (editingOrder ? "保存更正" : "确认交易")}</button></div>
          </AppModal>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full">
      {/* 一级标题 */}
      <div className="mb-4 flex items-center gap-2.5">
        <h2 className="text-lg font-bold">我的持仓</h2>
        <QuoteSourceBadge records={records} quotes={quotes} />
        <RefreshButton onClick={() => void refreshAccount()} title="刷新账户资产" />
      </div>

      {/* 添加股票 */}
      <div className="card mb-5 p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-bold">添加股票</span>
          {added && <span className="text-xs font-semibold text-brand-deep">{added} ✓</span>}
        </div>
        <div className="mx-auto max-w-[520px]">
          <StockSearch rainbow large onSelect={handleSelect} onCameraClick={() => setImportOpen(true)} placeholder="如：腾讯 / 00700 / AAPL / 茅台" />
        </div>
      </div>

      {/* 市场按钮（可拖动排序，第一个为默认显示，加号编辑/新增市场） */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {/* 总资产：全市场汇总，位于最左侧 */}
        <button
          type="button"
          onClick={() => switchMarket("TOTAL")}
          title="总资产：全部市场汇总"
          className={`pill-spring flex items-center gap-1.5 rounded-full px-4 py-2 text-sm ${
            active === "TOTAL"
              ? "border border-edge-strong bg-white font-semibold text-ink-2 shadow-sm hover:bg-brand-hover hover:text-ink active:bg-bg-gray"
              : "border border-edge-strong bg-white font-semibold text-muted hover:bg-brand-hover hover:text-ink active:bg-bg-gray"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
            <rect x="3" y="6" width="18" height="13" rx="2.5" />
            <path d="M3 10h18" />
            <path d="M7 15h4" />
          </svg>
          总资产
          <span className={`text-xs tabular-nums ${active === "TOTAL" ? "opacity-80" : "text-faint"}`}>
            {metricsReady ? compactMoney(displayedNetAsset, totalCurLabel) : "…"}
          </span>
        </button>
        {displayedTabs.map((m, i) => {
          const count = holdingsPool.filter((p) => p.market === m).length;
          const activeTab = active === m;
          return (
            <button
              key={m}
              type="button"
              draggable
              onDragStart={(e) => {
                dragIndex.current = i;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDropTab(i)}
              onDragEnd={() => {
                dragIndex.current = null;
              }}
              onClick={() => switchMarket(m)}
              title="拖动排序 · 第一个为默认市场"
              className={`pill-spring flex cursor-grab items-center gap-1.5 rounded-full px-4 py-2 text-sm active:cursor-grabbing ${
                activeTab
                  ? "border border-edge-strong bg-white font-semibold text-ink-2 shadow-sm hover:bg-brand-hover hover:text-ink active:bg-bg-gray"
                  : "border border-edge-strong bg-white font-semibold text-muted hover:bg-brand-hover hover:text-ink active:bg-bg-gray"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3 opacity-50">
                <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
              </svg>
              <MarketIcon market={m} flag={flagFor(m)} size={18} />
              {labelFor(m)}
              <span className={`text-xs tabular-nums ${activeTab ? "opacity-80" : "text-faint"}`}>{count}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => (editorOpen ? setEditorOpen(false) : openEditor())}
          className="pill-spring flex h-[36px] w-[36px] items-center justify-center rounded-full border border-dashed border-edge-strong text-lg font-bold text-muted hover:bg-brand-light hover:text-brand-deep"
          title="编辑 / 新增市场"
        >
          +
        </button>
      </div>

      {/* 总资产视图：显示货币切换 */}
      {active === "TOTAL" && (
        <div className="mb-4 flex items-center gap-2.5">
          <span className="text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">显示货币</span>
          <CurrencySelect value={displayCur} onChange={setDisplayCur} />
        </div>
      )}

      {/* 五张指标卡 */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <div className="card p-4">
          <span className="block text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">净资产（{totalCurLabel}）</span>
          <strong className="mt-1 block text-lg font-extrabold tabular-nums">{metricsReady ? compactMoney(displayedNetAsset, totalCurLabel) : "…"}</strong>
        </div>
        <div className="card p-4">
          <span className="block text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">当日盈亏</span>
          <strong className={`mt-1 block text-lg font-extrabold tabular-nums ${metrics.day >= 0 ? "text-up" : "text-down"}`}>
            {metricsReady ? `${metrics.day >= 0 ? "+" : "-"}${compactMoney(Math.abs(metrics.day * totalFactor), totalCurLabel)}` : "…"}
          </strong>
        </div>
        <div className="card p-4">
          <span className="block text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">持仓市值</span>
          <strong className="mt-1 block text-lg font-extrabold tabular-nums">{metricsReady ? compactMoney(metrics.mv * totalFactor, totalCurLabel) : "…"}</strong>
        </div>
        <div className="card p-4">
          <span className="block text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">持仓盈亏</span>
          <strong className={`mt-1 block text-lg font-extrabold tabular-nums ${metrics.pnl >= 0 ? "text-up" : "text-down"}`}>
            {metricsReady ? `${metrics.pnl >= 0 ? "+" : "-"}${compactMoney(Math.abs(metrics.pnl * totalFactor), totalCurLabel)}` : "…"}
          </strong>
        </div>
        <div className="card p-4">
          <span className="block text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">持仓盈亏率</span>
          <strong className={`mt-1 block text-lg font-extrabold tabular-nums ${metrics.rate !== null && metrics.rate >= 0 ? "text-up" : metrics.rate !== null ? "text-down" : "text-ink"}`}>
            {metricsReady ? (metrics.rate !== null ? `${metrics.rate >= 0 ? "+" : ""}${fmtPct(metrics.rate)}` : "—") : "…"}
          </strong>
        </div>
      </div>

      {/* 总资产视图：市场盈亏明细 */}
      {active === "TOTAL" && marketPnl.length > 0 && (
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-bold text-ink">市场盈亏</h3>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {orderedPnl.map(([m, e], i) => {
              const marketFactor = toUsd(m, 1) * totalFactor;
              const rate = e.cost ? e.pnl / e.cost : null;
              return (
                <div
                  key={m}
                  draggable
                  onDragStart={(ev) => {
                    pnlDragIndex.current = i;
                    ev.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(ev) => ev.preventDefault()}
                  onDrop={() => dropPnlCard(i)}
                  onDragEnd={() => {
                    pnlDragIndex.current = null;
                  }}
                  title="按住拖动排序"
                  className="group relative cursor-grab rounded-[16px] border border-edge bg-white p-4 shadow-card transition-all duration-300 ease-out hover:border-edge-strong/50 hover:shadow-pop active:cursor-grabbing"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-bold text-ink">
                      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5 flex-none cursor-grab text-faint opacity-60 active:cursor-grabbing">
                        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                      </svg>
                      <MarketIcon market={m} flag={flagFor(m)} size={20} />
                      <span className="truncate">{labelFor(m)}</span>
                    </span>
                    <span className="flex-none text-[11px] font-mono text-faint">{totalCur}</span>
                  </div>
                  <div className="mt-4 space-y-2.5">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-[#73777f] dark:text-[#a3a8b2]">持仓盈利</span>
                      <strong className={`text-[15px] font-bold tabular-nums ${e.pnl >= 0 ? "text-up" : "text-down"}`}>
                        {metricsReady ? `${e.pnl >= 0 ? "+" : "-"}${compactMoney(Math.abs(e.pnl * marketFactor), totalCurLabel)}` : "…"}
                      </strong>
                    </div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-[#73777f] dark:text-[#a3a8b2]">盈亏率</span>
                      <strong className={`text-[15px] font-bold tabular-nums ${rate !== null && rate >= 0 ? "text-up" : rate !== null ? "text-down" : "text-faint"}`}>
                        {metricsReady ? (rate !== null ? `${rate >= 0 ? "+" : ""}${fmtPct(rate)}` : "—") : "…"}
                      </strong>
                    </div>
                    <div className="flex items-baseline justify-between border-t border-edge pt-2.5">
                      <span className="text-xs text-[#73777f] dark:text-[#a3a8b2]">持仓市值</span>
                      <strong className="text-sm font-semibold tabular-nums text-ink">{metricsReady ? compactMoney(e.mv * marketFactor, totalCurLabel) : "…"}</strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 市场股票表 */}
      <div className="card min-w-0 max-w-full overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-20 text-center text-sm text-faint">
            {active === "TOTAL" ? "暂无持仓，可在上方「添加股票」搜索加入。" : `${labelFor(active)}暂无股票，可在上方「添加股票」搜索加入，填写数量后计入持仓。`}
          </div>
        ) : (
          <>
            <div className="data-table-scroll">
              <table className="mobile-holdings-table w-full text-sm" style={{ minWidth: `${Math.max(860, (enabledHoldingColumns.length + 3) * 135)}px` }}>
                <thead>
                  <tr className="whitespace-nowrap bg-bg-gray text-xs font-semibold text-[#73777f] dark:text-[#a3a8b2]">
                    <th data-mobile-column="rank" className="px-3 py-[13px] text-center">序号</th>
                    {enabledHoldingColumns.map((column) => <SortTh key={column.key} dataColumn={column.key} label={HOLDING_COLUMN_LABELS[column.key]} align={column.key === "identity" ? "left" : "right"} k={HOLDING_SORT_KEYS[column.key]} sort={sort} onSort={toggleSort} />)}
                    <th data-mobile-column="broker" className="px-4 py-[13px] text-left">券商</th>
                    <th data-mobile-column="actions" className="px-4 py-[13px] text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => {
                    return (
                      <tr key={r.id} className="whitespace-nowrap border-t border-edge transition-colors hover:bg-bg-gray/60 dark:hover:bg-[#1b2230]">
                        <td data-mobile-column="rank" className="px-3 py-3.5 text-center text-xs tabular-nums text-faint">{(safePage - 1) * PAGE_SIZE + i + 1}</td>
                        {enabledHoldingColumns.map((column) => <td key={column.key} data-mobile-column={column.key} className={`px-4 py-3.5 tabular-nums ${column.key === "identity" ? "text-left" : "text-right"}`}>{holdingColumnCell(r, column.key)}</td>)}
                        <td data-mobile-column="broker" className="px-4 py-3.5">
                          {r.group ? (
                            <span className="inline-flex max-w-[140px] items-center gap-1.5 truncate rounded-full bg-bg-gray px-2.5 py-1 text-xs font-medium text-muted">
                              {brokerIcons[r.group] ? (
                                <img src={brokerIcons[r.group]} alt="" className="h-4 w-4 flex-none rounded-full object-cover" />
                              ) : (
                                <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-white/70 text-[9px] font-bold text-muted dark:bg-white/10">
                                  {r.group.slice(0, 1)}
                                </span>
                              )}
                              <span className="truncate">{r.group}</span>
                            </span>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td data-mobile-column="actions" className="px-4 py-3.5">
                          <div className="flex justify-end gap-1.5">
                          <button type="button" title="编辑" onClick={() => openEdit(r)} className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-edge bg-white text-muted transition-colors hover:bg-brand-hover hover:text-ink">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                          </button>
                          <button type="button" title="删除" onClick={() => onRemove(r)} className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] border border-white bg-bg-gray text-muted transition-colors hover:bg-brand-hover hover:text-ink dark:border-white/20 dark:bg-[#1c222d] dark:text-white/70 dark:hover:border-white/40 dark:hover:bg-white/10 dark:hover:text-white">
                            <DeleteIcon size={15} />
                          </button>
                        </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 分页：每页 6 只 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-edge bg-bg-gray/50 px-4 py-3">
                <span className="text-xs text-muted">共 {filtered.length} 只 · 第 {safePage} / {totalPages} 页（每页 6 只）</span>
                <div className="flex gap-2">
                  <button type="button" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-full border border-edge-strong bg-white px-5 text-sm font-semibold text-brand-deep whitespace-nowrap transition-all duration-200 hover:bg-brand-hover hover:text-ink active:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
                  <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-full border border-edge-strong bg-white px-5 text-sm font-semibold text-brand-deep whitespace-nowrap transition-all duration-200 hover:bg-brand-hover hover:text-ink active:bg-bg-gray disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {active === "TOTAL" && positions.length > 0 && (
        <div className="holdings-sankey-module mt-6">
          <HoldingsPnlSankey
            profit={pnlSankey.profit}
            loss={pnlSankey.loss}
            profitTotal={pnlSankey.profitTotal}
            lossTotal={pnlSankey.lossTotal}
            rates={rates}
          />
        </div>
      )}

      {/* 市场编辑弹窗 */}
      {editorOpen && (
        <AppModal title="编辑市场" desc="名称可编辑；市场图标统一从素材库读取。勾选控制显示/隐藏，可新增任意市场。" onClose={() => setEditorOpen(false)} size="lg">
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
              {editorRows.map((row) => {
                const editing = editingKey === row.key;
                return (
                  <div key={row.key} className="flex items-center gap-2.5 rounded-[12px] border border-edge px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={row.active}
                      onChange={(e) => updateRow(row.key, { active: e.target.checked })}
                      className="h-4 w-4 cursor-pointer accent-[#3297f6]"
                      title="是否在标签栏显示"
                    />
                    {editing ? (
                      <>
                        <span className="flex w-[72px] flex-none items-center justify-center">
                          <MarketIcon market={row.key} size={20} />
                        </span>
                        <input
                          value={row.label}
                          onChange={(e) => updateRow(row.key, { label: e.target.value })}
                          className="h-8 min-w-0 flex-1 rounded-[8px] border border-edge-strong px-2 text-sm outline-none transition-shadow focus:border-edge-strong"
                          placeholder="市场名称"
                        />
                        <button
                          type="button"
                          onClick={() => setEditingKey(null)}
                          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-white text-ink-2 border border-edge-strong shadow-sm transition-colors hover:bg-brand-hover"
                          title="完成编辑"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M20 6 9 17l-5-5" /></svg>
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex w-[72px] flex-none items-center justify-center">
                          <MarketIcon market={row.key} flag={row.flag} size={20} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{row.label || row.key}</span>
                        <span className="flex-none rounded-[7px] bg-bg-gray px-2 py-1 text-[11px] font-semibold text-faint">{row.key}</span>
                        {!hasMarketRecords(row.key) && (
                          <span
                            className="flex-none rounded-[7px] border border-dashed border-edge-strong px-2 py-1 text-[11px] font-semibold text-faint"
                            title="该市场暂无持仓 / 本页添加的记录，标签栏会自动隐藏；添加记录后标签自动出现（顺序沿用这里）"
                          >
                            无记录 · 自动隐藏
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingKey(row.key)}
                          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-edge text-muted transition-colors hover:bg-brand-light hover:text-brand-deep"
                          title="编辑市场名称"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 新增市场 */}
            <div className="mt-4 border-t border-edge pt-4">
              <span className="text-xs font-bold text-muted">新增市场（不限于美股/港股等）</span>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={newMarket.key}
                  onChange={(e) => setNewMarket({ ...newMarket, key: e.target.value })}
                  className="field w-[130px]"
                  placeholder="代码，如 SG / CA"
                />
                <input
                  value={newMarket.label}
                  onChange={(e) => setNewMarket({ ...newMarket, label: e.target.value })}
                  className="field w-[160px]"
                  placeholder="名称，如 新加坡"
                />
                <button type="button" onClick={addMarket} className="btn btn-ghost btn-sm">＋ 新增</button>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2.5">
              <button type="button" onClick={() => setEditorOpen(false)} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" onClick={saveMarketEditor} className="btn btn-line btn-sm">保存</button>
            </div>
        </AppModal>
      )}

      {/* 编辑弹窗 */}
      {editRecord && (
        <AppModal title="编辑股票" desc={`${editRecord.name} · ${editRecord.code} · ${marketMeta(editRecord.market).label}`} onClose={() => setEditRecord(null)} size="md">
            <div className="grid grid-cols-2 gap-3.5">
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                股票名称
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                现价
                <input type="number" step="0.001" value={editForm.price} onChange={(e) => setEditForm({ ...editForm, price: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                成本价
                <input type="number" step="0.001" value={editForm.cost} onChange={(e) => setEditForm({ ...editForm, cost: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                数量
                <input type="number" step="any" value={editForm.qty} onChange={(e) => setEditForm({ ...editForm, qty: e.target.value })} className="field" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                市场
                <MarketSelect
                  value={editForm.market}
                  onChange={(v) => setEditForm({ ...editForm, market: v })}
                  options={recordMarketOptions}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                券商
                <GroupSelect
                  value={editForm.group}
                  onChange={(v) => setEditForm({ ...editForm, group: v })}
                  groups={[...groups.map((g) => g.name), ...records.map((r) => r.group).filter(Boolean)]}
                  brokerIcons={brokerIcons}
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                备注
                <input value={editForm.note} onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} className="field" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2.5">
              <button type="button" onClick={() => setEditRecord(null)} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" disabled={editSaving} onClick={saveEdit} className="btn btn-line btn-sm disabled:opacity-60">
                {editSaving ? "保存中…" : "保存"}
              </button>
            </div>
        </AppModal>
      )}

      {importOpen && (
        <ImportSnapshotModal
          mode="holdings"
          onClose={() => setImportOpen(false)}
          onImported={() => {
            // 触发父层重拉记录 + 强制刷新行情，导入的持仓/自选立即生效
            window.dispatchEvent(new Event("fire:records-updated"));
            void refreshQuotes?.({ force: true });
          }}
        />
      )}
    </div>
  );
}
