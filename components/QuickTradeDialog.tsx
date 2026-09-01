"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { StockRecord } from "@/lib/types";
import { showToast } from "@/lib/toast";

type Side = "buy" | "sell";
type TradeMode = "order" | "record";

const ORDER_TYPES = [
  "限价单", "市价单", "到价买入", "到价卖出", "反弹买入", "回落卖出"
] as const;
const VALIDITIES = ["当日有效", "撤单前有效", "自定义有效期"] as const;
const SESSIONS = ["盘中 + 盘前盘后", "仅盘中", "盘前", "盘后"] as const;
const ORDER_TYPE_CODE: Record<(typeof ORDER_TYPES)[number], string> = {
  限价单: "limit", 市价单: "market", 到价买入: "trigger_buy", 到价卖出: "trigger_sell", 反弹买入: "rebound_buy", 回落卖出: "rebound_sell"
};
const VALIDITY_CODE: Record<(typeof VALIDITIES)[number], string> = { 当日有效: "day", 撤单前有效: "gtc", 自定义有效期: "custom" };
const WINDOW_GUTTER = 12;
const APP_HEADER_HEIGHT = 72;

const MARKET_TIME_ZONE: Record<string, { zone: string; label: string }> = {
  US: { zone: "America/New_York", label: "美东时间" },
  HK: { zone: "Asia/Hong_Kong", label: "香港时间" },
  CN: { zone: "Asia/Shanghai", label: "北京时间" },
  JP: { zone: "Asia/Tokyo", label: "日本时间" },
  KR: { zone: "Asia/Seoul", label: "韩国时间" }
};

function zonedInputValue(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** 将交易所当地时间输入转换为 ISO；迭代一次可同时覆盖美股夏令时。 */
function zonedInputToIso(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "";
  const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const shown = zonedInputValue(new Date(guess), timeZone);
    const seen = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(shown);
    if (!seen) break;
    const seenUtc = Date.UTC(Number(seen[1]), Number(seen[2]) - 1, Number(seen[3]), Number(seen[4]), Number(seen[5]));
    guess += wanted - seenUtc;
  }
  // 夏令时切换会产生不存在的当地时间；必须往返一致才允许入账。
  if (zonedInputValue(new Date(guess), timeZone) !== value) return "";
  return new Date(guess).toISOString();
}

function className(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

interface Props {
  open: boolean;
  record: StockRecord | null;
  initialSide: Side;
  initialQty?: number;
  livePrice: (r: StockRecord) => number;
  maxBuyPower?: number;
  dayChange?: number;
  stockIcons?: Record<string, string>;
  onClose: () => void;
  onDone?: () => void;
}

export default function QuickTradeDialog({ open, record, initialSide, initialQty, livePrice, maxBuyPower = 0, dayChange = 0, stockIcons, onClose, onDone }: Props) {
  const [side, setSide] = useState<Side>(initialSide);
  const [tradeMode, setTradeMode] = useState<TradeMode>("order");
  const [orderType, setOrderType] = useState<(typeof ORDER_TYPES)[number]>("限价单");
  const [qty, setQty] = useState<number>(0);
  const [qtyStr, setQtyStr] = useState<string>("0");
  const [price, setPrice] = useState<number>(0);
  const [priceStr, setPriceStr] = useState<string>("0");
  const [validity, setValidity] = useState<(typeof VALIDITIES)[number]>("当日有效");
  const [session, setSession] = useState<(typeof SESSIONS)[number]>("盘中 + 盘前盘后");
  const [showQtyMenu, setShowQtyMenu] = useState(false);
  const [showPriceMenu, setShowPriceMenu] = useState(false);
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [showValidityMenu, setShowValidityMenu] = useState(false);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [tradedAt, setTradedAt] = useState<string>("");
  const [calMonth, setCalMonth] = useState<{ y: number; m: number }>(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [showFractions, setShowFractions] = useState(false);
  const [fixedTop, setFixedTop] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [winPos, setWinPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const winPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const winRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; left: number; top: number; w: number; h: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const livePriceRef = useRef(livePrice);
  livePriceRef.current = livePrice;

  function keepWindowInViewport() {
    const el = winRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxLeft = Math.max(WINDOW_GUTTER, window.innerWidth - r.width - WINDOW_GUTTER);
    const minTop = APP_HEADER_HEIGHT + WINDOW_GUTTER;
    const maxTop = Math.max(minTop, window.innerHeight - r.height - WINDOW_GUTTER);
    const left = Math.max(WINDOW_GUTTER, Math.min(maxLeft, r.left));
    const top = Math.max(minTop, Math.min(maxTop, r.top));
    if (left === r.left && top === r.top) return;
    const p = { x: winPosRef.current.x + left - r.left, y: winPosRef.current.y + top - r.top };
    winPosRef.current = p;
    setWinPos(p);
  }

  // 恢复上次拖动位置，默认居中（0,0）
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("fire:trade-window-pos") || "null") as { x?: number; y?: number } | null;
      const x = saved?.x;
      const y = saved?.y;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 5000 && Math.abs(y) < 5000) {
        const p = { x, y };
        winPosRef.current = p;
        setWinPos(p);
      }
    } catch {
      /* 忽略损坏的位置 */
    }
  }, []);

  // 拖动窗口：卡片始终完整保留在当前视口内。
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const nl = Math.max(WINDOW_GUTTER, Math.min(window.innerWidth - d.w - WINDOW_GUTTER, d.left + e.clientX - d.sx));
      const minTop = APP_HEADER_HEIGHT + WINDOW_GUTTER;
      const nt = Math.max(minTop, Math.min(window.innerHeight - d.h - WINDOW_GUTTER, d.top + e.clientY - d.sy));
      const p = { x: d.x + nl - d.left, y: d.y + nt - d.top };
      winPosRef.current = p;
      setWinPos(p);
    }
    function onUp() {
      dragRef.current = null;
      setDragging(false);
      try {
        localStorage.setItem("fire:trade-window-pos", JSON.stringify(winPosRef.current));
      } catch {
        /* localStorage 不可用时仅本次拖动生效 */
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // 保存的位置、窗口缩放或最大化切换后，都重新收进可视区域。
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(keepWindowInViewport);
    window.addEventListener("resize", keepWindowInViewport);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepWindowInViewport);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, minimized, maximized]);

  function onTitleMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button,input,select,textarea,a,[data-drag-skip]")) return;
    const el = winRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height, x: winPosRef.current.x, y: winPosRef.current.y };
    setDragging(true);
  }

  // 打开时初始化
  useEffect(() => {
    if (!open || !record) return;
    setSide(initialSide);
    setTradeMode("order");
    setOrderType("限价单");
    setValidity("当日有效");
    setExpiryDate("");
    setShowCalendar(false);
    setSession("盘中 + 盘前盘后");
    const zone = MARKET_TIME_ZONE[record.market.toUpperCase()]?.zone || "Asia/Shanghai";
    setTradedAt(zonedInputValue(new Date(), zone));
    const p = livePriceRef.current(record) || 0;
    setPrice(p);
    setPriceStr(p ? fmtP(p) : "0");
    const q = initialQty ?? 0;
    setQty(q);
    setQtyStr(q ? String(round(q, 4)) : "0");
    setShowFractions(false);
    setMinimized(false);
    setMaximized(false);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id, initialSide, initialQty]);

  const holdQty = Number(record?.qty) || 0;      // 持仓可卖
  const priceN = Number(priceStr) || 0;
  const qtyN = Number(qtyStr) || 0;
  const isBuy = side === "buy";
  const minUnit = usableMinUnit(record?.market ?? "");
  const cur = ({ US: "USD", HK: "HKD", CN: "CNY", JP: "JPY", KR: "KRW" } as Record<string, string>)[(record?.market ?? "").toUpperCase()] || "USD";
  const marketTime = MARKET_TIME_ZONE[(record?.market ?? "").toUpperCase()] || { zone: "Asia/Shanghai", label: "当地时间" };
  const sellable = holdQty;
  const currentQuote = record ? livePrice(record) : 0;
  const limitReached = orderType === "限价单" && currentQuote > 0
    ? (isBuy ? currentQuote <= priceN : currentQuote >= priceN)
    : false;
  const maxBuyN = priceN > 0 ? maxBuyPower / priceN : 0;
  const estAmount = qtyN * priceN;
  const estCost = (() => {
    const cost = Number(record?.cost) || 0;
    const totalQty = isBuy ? holdQty + qtyN : Math.max(0, holdQty - qtyN);
    if (!isBuy) return cost;
    return totalQty > 0 ? (cost * holdQty + estAmount) / totalQty : 0;
  })();

  // 数量快捷菜单
  const qtyOptions = useMemo(() => {
    const total = isBuy ? maxBuyN : sellable;
    if (!total || total <= 0) return [];
    return [
      { label: "全仓", value: total },
      { label: "1/2", value: total / 2 },
      { label: "1/3", value: total / 3 },
      { label: "1/4", value: total / 4 }
    ];
  }, [isBuy, maxBuyN, sellable]);

  // 价格梯子（围绕行情价上下几档，含市价）
  const priceLadder = useMemo(() => {
    const market = (record ? livePrice(record) : 0) || priceN || 0;
    if (!market) return [];
    const step = Math.max(round(market * 0.002, 2), 0.01);
    return [3, 2, 1, 0, -1, -2, -3].map((i) => {
      const p = Math.max(0.01, round(market + i * step, 2));
      return { p, pct: i === 0 ? 0 : (i * step / market) * 100, isMarket: i === 0 };
    });
  }, [priceN, record, livePrice]);

  function applyQty(v: number) {
    const n = Math.max(0, v);
    setQtyStr(String(round(n, 4)));
    setQty(n);
    setShowQtyMenu(false);
  }
  function stepper(next: number) {
    applyQty(next);
  }

  async function submit() {
    if (!record || submitting) return;
    if (qtyN <= 0) { alert("请输入有效的数量"); return; }
    if (priceN <= 0) { alert("请输入有效的价格"); return; }
    if (tradeMode === "order" && validity === "自定义有效期" && !expiryDate) { alert("请选择有效期"); return; }
    const tradedAtIso = tradeMode === "record" ? zonedInputToIso(tradedAt, marketTime.zone) : "";
    if (tradeMode === "record" && (!tradedAtIso || Date.parse(tradedAtIso) > Date.now() + 60_000)) {
      alert("请选择不晚于当前时间的有效成交时间");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: record.id,
          side,
          qty: qtyN,
          price: priceN,
          fees: 0,
          mode: tradeMode,
          orderType: ORDER_TYPE_CODE[orderType],
          tif: VALIDITY_CODE[validity],
          expiresAt: validity === "自定义有效期" ? expiryDate : null,
          session,
          tradedAt: tradedAtIso || undefined,
          note: tradeMode === "record" ? "手工补录已成交" : "快捷委托"
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        alert(data?.error || "下单失败");
        return;
      }
      showToast(tradeMode === "record" ? "历史成交已入账" : data?.data?.pending ? "已挂单，等待成交" : "委托已成交", "ok");
      window.dispatchEvent(new Event("fire:records-updated"));
      window.dispatchEvent(new Event("fire:orders-updated"));
      onDone?.();
      onClose();
    } catch {
      alert("下单失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || !record) return null;

  const fieldBorder = isBuy ? "border-[#f26b41] dark:border-[#bd4218]" : "border-[#2fbf93] dark:border-[#0b855f]";
  const fieldBg = "bg-white text-[#1d1d1f] dark:bg-[#171419] dark:text-white/90";
  const inputCls = `h-9 w-full rounded-lg border ${fieldBorder} ${fieldBg} px-3 text-sm outline-none transition-colors focus:border-brand`;
  const stepperCls = "grid h-9 w-8 place-items-center text-lg text-[#8a8a8e] transition-colors hover:text-[#1d1d1f] dark:text-white/70 dark:hover:text-white";
  const directionCls = (active: boolean) =>
    className(
      "flex h-9 flex-1 items-center justify-center text-sm font-semibold transition-colors",
      active
        ? isBuy
          ? "bg-[#ff6a3d] text-white"
          : "bg-[#00a985] text-white"
        : "text-[#8a8a8e] hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
    );

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-3" onClick={() => { if (!fixedTop) onClose(); }}>
      <div
        ref={winRef}
        style={{ transform: `translate(${winPos.x}px, ${winPos.y}px)` }}
        onClick={(e) => e.stopPropagation()}
        className={className(
          "quick-trade-window relative max-h-[calc(100dvh-96px)] w-full overflow-y-auto overflow-x-hidden rounded-2xl border shadow-2xl transition-[max-width]",
          maximized ? "max-w-[920px]" : "max-w-[560px]",
          isBuy
            ? "border-[#f0ad8c] bg-[#fff9f5] dark:border-[#5a2a18] dark:bg-[#381201]"
            : "border-[#8fd6bf] bg-[#f5fdf9] dark:border-[#1f5a45] dark:bg-[#002e25]"
        )}
      >
        {/* 四角均可拖动；热区只占最外侧，不覆盖标题栏按钮。 */}
        {(["left-0 top-0 cursor-nwse-resize", "right-0 top-0 cursor-nesw-resize", "bottom-0 left-0 cursor-nesw-resize", "bottom-0 right-0 cursor-nwse-resize"] as const).map((position) => (
          <div key={position} aria-hidden className={`absolute z-30 h-3 w-3 ${position}`} onMouseDown={onTitleMouseDown} />
        ))}
        {/* 标题栏 */}
        <div
          onMouseDown={onTitleMouseDown}
          title="按住拖动窗口"
          className="quick-trade-titlebar flex cursor-grab touch-none select-none items-center gap-2 bg-white px-4 py-3 active:cursor-grabbing dark:bg-black"
        >
          <span className="flex items-center gap-1.5">
            <button type="button" onClick={onClose} title="关闭" className="group grid h-3 w-3 place-items-center rounded-full bg-[#ff5f57]"><svg viewBox="0 0 12 12" className="h-2 w-2 text-black/60 opacity-0 transition-opacity group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m3.5 3.5 5 5M8.5 3.5l-5 5" /></svg></button>
            <button type="button" onClick={() => setMinimized((v) => !v)} title={minimized ? "还原" : "最小化"} className="group grid h-3 w-3 place-items-center rounded-full bg-[#febc2e]"><svg viewBox="0 0 12 12" className="h-2 w-2 text-black/60 opacity-0 transition-opacity group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2.5 6h7" /></svg></button>
            <button type="button" onClick={() => setMaximized((v) => !v)} title={maximized ? "还原大小" : "最大化"} className="group grid h-3 w-3 place-items-center rounded-full bg-[#28c840]"><svg viewBox="0 0 12 12" className="h-2 w-2 text-black/60 opacity-0 transition-opacity group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M6 3v6M3 6h6" /></svg></button>
          </span>
          <span className="ml-2 text-sm font-bold text-[#1d1d1f] dark:text-white/90">交易</span>
          <button
            type="button"
            onClick={() => setFixedTop((v) => !v)}
            title="固定窗口在顶部"
            className={className("ml-auto grid h-7 w-7 place-items-center rounded-md transition-colors", fixedTop ? "text-[#38bdf8]" : "text-[#6b6b70] dark:text-white/60 hover:text-[#1d1d1f] dark:hover:text-white")}
          >
            <svg viewBox="0 0 24 24" fill={fixedTop ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M14 4v5l3 3v2H7v-2l3-3V4" />
              <path d="M9 4h6" />
              <path d="M12 14v6" />
            </svg>
          </button>
          <button type="button" onClick={onClose} title="关闭" className="grid h-7 w-7 place-items-center rounded-md text-[#6b6b70] dark:text-white/60 transition-colors hover:text-[#1d1d1f] dark:hover:text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* 标题 / 代码 */}
        <div className="flex items-center gap-2 bg-white px-5 py-4 dark:bg-[#171419]">
          {(() => {
            const icon = stockIcons?.[`${record.market.toUpperCase()}:${record.code.toUpperCase()}`];
            return icon
              ? <img src={icon} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
              : <i className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-gray not-italic text-ink-2">{record.name.slice(0, 1)}</i>;
          })()}
          <span className="text-lg font-bold text-[#1d1d1f] dark:text-white">{record.name}</span>
          <span className="text-sm text-[#6b6b70] dark:text-white/60">{record.code}.{record.market}</span>
          <span className="flex-1" />
        </div>

        <div className={className("px-5 pb-3", minimized && "hidden")}>
          {/* 代码 / 类型 */}
          <div className="quick-trade-form grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <span className="mb-1 block text-xs text-[#8a8a8a] dark:text-white/60">操作方式</span>
              <div className={`grid grid-cols-2 overflow-hidden rounded-lg border ${fieldBorder} ${fieldBg}`}>
                <button type="button" onClick={() => setTradeMode("order")} className={className("h-9 text-sm font-semibold transition-colors", tradeMode === "order" ? (isBuy ? "bg-[#ff6a3d] text-white" : "bg-[#00a985] text-white") : "text-[#6b6b70] hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5")}>提交委托</button>
                <button type="button" onClick={() => setTradeMode("record")} className={className("h-9 text-sm font-semibold transition-colors", tradeMode === "record" ? (isBuy ? "bg-[#ff6a3d] text-white" : "bg-[#00a985] text-white") : "text-[#6b6b70] hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5")}>记录已成交</button>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[#6b6b70] dark:text-white/55">
                {tradeMode === "record"
                  ? "仅用于补录券商已经成交的记录，成交价格以券商单据为准。"
                  : orderType === "限价单" && currentQuote > 0
                    ? `当前 ${fmtP(currentQuote)}，${isBuy ? "买入" : "卖出"}限价 ${fmtP(priceN)} ${limitReached ? "已满足触发条件" : "尚未达到，提交后保持待成交"}。`
                    : "委托将按实时行情与所选触发条件处理。"}
              </p>
            </div>
            <div className="hidden sm:block"><Field label="代码"><input value={`${record.code}.${record.market}`} readOnly className={inputCls} /></Field></div>
            {tradeMode === "order" ? <Field label="类型">
              <Dropdown value={orderType} open={showTypeMenu} onToggle={() => setShowTypeMenu((v) => !v)} onClose={() => setShowTypeMenu(false)} btnCls={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border ${fieldBorder} ${fieldBg} px-3 text-sm outline-none transition-colors`}>
                {ORDER_TYPES.map((t) => <MenuItem key={t} active={orderType === t} onClick={() => { setOrderType(t); setShowTypeMenu(false); }}>{t}</MenuItem>)}
              </Dropdown>
            </Field> : <Field label={`成交时间（${marketTime.label}）`}>
              <input type="datetime-local" value={tradedAt} max={zonedInputValue(new Date(), marketTime.zone)} onChange={(e) => setTradedAt(e.target.value)} className={inputCls} />
            </Field>}
            {/* 方向 */}
            <Field label="方向">
              <div className={`flex h-9 overflow-hidden rounded-lg border ${fieldBorder}`}>
                <button type="button" className={directionCls(isBuy)} onClick={() => setSide("buy")}>买入</button>
                <button type="button" className={directionCls(!isBuy)} onClick={() => setSide("sell")}>卖出</button>
              </div>
            </Field>
            <Field label="价格">
              <div className="relative">
                <div className={`flex h-9 overflow-hidden rounded-lg border ${fieldBorder} ${fieldBg}`}>
                  <button type="button" className={stepperCls} onClick={() => setPriceStr(fmtP(priceN - priceStep(record.market)))}>−</button>
                  <input value={priceStr} onChange={(e) => setPriceStr(e.target.value)} onBlur={() => setPriceStr(fmtP(priceN))} inputMode="decimal" className="min-w-0 flex-1 bg-transparent text-center text-sm text-[#1d1d1f] dark:text-white outline-none" />
                  <button type="button" className={stepperCls} onClick={() => setPriceStr(fmtP(priceN + priceStep(record.market)))}>+</button>
                  <button type="button" title="价格梯子" className="grid w-10 place-items-center border-l border-[#ececef] dark:border-[#3a3a40] text-[#6b6b70] dark:text-white/60 hover:text-[#1d1d1f] dark:hover:text-white" onClick={() => { setShowPriceMenu((v) => !v); setShowQtyMenu(false); setShowTypeMenu(false); setShowValidityMenu(false); setShowSessionMenu(false); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /><path d="M12 3v3.5M12 17.5v3.5M3 12h3.5M17.5 12H21" /></svg></button>
                </div>
                {showPriceMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowPriceMenu(false)} />
                    <div className="absolute right-0 top-full z-20 mt-1 w-[128px] overflow-hidden rounded-lg border border-[#ececef] dark:border-white/12 bg-white dark:bg-[#0d1418] shadow-xl">
                      <div className="max-h-56 overflow-auto">
                        {priceLadder.map((l) => (
                          <button key={l.p} type="button" onClick={() => { setPrice(l.p); setPriceStr(fmtP(l.p)); setShowPriceMenu(false); }} className={className("flex w-full items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5", l.isMarket ? "bg-black/5 dark:bg-white/5" : "")}>
                            <span className={`tabular-nums ${l.isMarket ? "font-semibold text-[#1d1d1f] dark:text-white" : "text-[#1d1d1f] dark:text-white/80"}`}>{l.isMarket ? "市价" : fmtP(l.p)}</span>
                            <span className={className("tabular-nums", l.pct > 0 ? "text-[#ff7f57]" : l.pct < 0 ? "text-[#12bd97]" : "text-[#b5b5ba] dark:text-white/40")}>{l.isMarket ? "市价" : `${l.pct >= 0 ? "+" : ""}${round(l.pct, 1)}%`}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Field>
            {/* 数量 */}
            <Field label="数量">
              <div className="relative">
                <div className={`flex h-9 overflow-hidden rounded-lg border ${fieldBorder} ${fieldBg}`}>
                  <button type="button" className={stepperCls} onClick={() => stepper(qtyN - minUnit)}>−</button>
                  <input value={qtyStr} onChange={(e) => { setQtyStr(e.target.value); setQty(Number(e.target.value) || 0); }} inputMode="decimal" className="min-w-0 flex-1 bg-transparent text-center text-sm text-[#1d1d1f] dark:text-white outline-none" />
                  <button type="button" className={stepperCls} onClick={() => stepper(qtyN + minUnit)}>+</button>
                  <button type="button" title="数量快捷菜单" className="grid w-10 place-items-center border-l border-[#ececef] dark:border-[#3a3a40] text-[#6b6b70] dark:text-white/60 hover:text-[#1d1d1f] dark:hover:text-white" onClick={() => { setShowQtyMenu((v) => !v); setShowTypeMenu(false); setShowValidityMenu(false); setShowSessionMenu(false); setShowPriceMenu(false); }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4"><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 18 9 5 9-5" /></svg>
                  </button>
                </div>
                {showQtyMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setShowQtyMenu(false)} />
                    <div className="absolute left-1/2 top-full z-20 mt-1 w-56 -translate-x-1/2 overflow-hidden rounded-lg border border-[#ececef] dark:border-white/12 bg-white dark:bg-[#0d1418] shadow-xl">
                      <div className="grid grid-cols-2 border-b border-[#f0e2da] dark:border-white/10 text-[11px] whitespace-nowrap text-[#8a8a8a] dark:text-white/50"><span className="px-3 py-1.5 text-left">名称</span><span className="px-3 py-1.5 text-right">{isBuy ? "最大可买" : "持仓可卖"}</span></div>
                      <div className="max-h-44 overflow-auto">
                        {qtyOptions.length === 0 && <div className="px-3 py-3 text-center text-xs text-[#b5b5ba] dark:text-white/40">{isBuy ? "暂无可买" : "暂无可卖"}</div>}
                        {qtyOptions.map((o) => (
                          <button key={o.label} type="button" onClick={() => applyQty(o.value)} className="grid w-full grid-cols-2 px-3 py-1.5 text-left text-xs text-[#1d1d1f] dark:text-white/80 hover:bg-black/5 dark:hover:bg-white/5">
                            <span>{o.label}</span><span className="whitespace-nowrap text-right tabular-nums">{round(o.value, 4)}</span>
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center justify-between border-t border-[#f0e2da] dark:border-white/10 px-3 py-2">
                        <span className="text-xs text-[#6b6b70] dark:text-white/60">展示碎股</span>
                        <button type="button" onClick={() => setShowFractions((v) => !v)} className={className("relative h-5 w-9 rounded-full transition-colors", showFractions ? "bg-[#34c759]" : "bg-white/20")}>
                          <span className={className("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", showFractions ? "left-[18px]" : "left-0.5")} />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </Field>
            {/* 可买/可卖 */}
            <div className="col-span-1 flex h-9 items-center gap-3 text-xs text-[#6b6b70] dark:text-white/55">
              {isBuy ? (
                <>
                  <span>最大可买 <b className="text-[#1d1d1f] dark:text-white/85">{round(maxBuyN, 3)}</b> 股</span>
                </>
              ) : (
                <>
                  <span>持仓可卖 <b className="text-[#1d1d1f] dark:text-white/85">{round(sellable, 4)}</b> 股</span>
                </>
              )}
              <span title="最小单位" className="ml-auto text-[10px] text-[#b5b5ba] dark:text-white/40">最小单位 {minUnit}</span>
            </div>
            {/* 委托模式才需要时效 / 时段 */}
            {tradeMode === "order" && <><Field label="时效">
              <div className="relative">
                <Dropdown value={validity === "自定义有效期" && expiryDate ? expiryDate : validity} open={showValidityMenu} onToggle={() => { setShowValidityMenu((v) => !v); setShowQtyMenu(false); setShowTypeMenu(false); setShowSessionMenu(false); setShowCalendar(false); }} onClose={() => setShowValidityMenu(false)} btnCls={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border ${fieldBorder} ${fieldBg} px-3 text-sm outline-none transition-colors`}>
                  {VALIDITIES.map((v) => <MenuItem key={v} active={validity === v} onClick={() => { setValidity(v); setShowValidityMenu(false); if (v === "自定义有效期") setShowCalendar(true); }}>{v}</MenuItem>)}
                </Dropdown>
                {showCalendar && (
                  <Calendar
                    month={calMonth}
                    onMonth={(m) => setCalMonth(m)}
                    value={expiryDate}
                    onPick={(d) => { setExpiryDate(d); setShowCalendar(false); }}
                    onClose={() => setShowCalendar(false)}
                  />
                )}
              </div>
            </Field>
            <Field label="时段">
              <Dropdown value={session} open={showSessionMenu} onToggle={() => { setShowSessionMenu((v) => !v); setShowQtyMenu(false); setShowTypeMenu(false); setShowValidityMenu(false); }} onClose={() => setShowSessionMenu(false)} btnCls={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border ${fieldBorder} ${fieldBg} px-3 text-sm outline-none transition-colors`}>
                {SESSIONS.map((s) => <MenuItem key={s} active={session === s} onClick={() => { setSession(s); setShowSessionMenu(false); }}>{s}</MenuItem>)}
              </Dropdown>
            </Field></>}
          </div>

          {/* 预留底部留白，保证买入/卖出高度一致 */}
          <div className="h-4 sm:h-[104px]" aria-hidden />
        </div>

        {/* 底部 */}
        <div className={className("flex items-center gap-4 border-t border-[#00000010] px-5 py-4 dark:border-white/10", minimized && "hidden")}>
          <div className="min-w-0">
            <div className="text-lg font-extrabold tabular-nums text-[#1d1d1f] dark:text-white">{estAmount ? `${estAmount.toFixed(2)} ${cur}` : `0.00 ${cur}`}</div>
            <div className="truncate text-xs text-[#6b6b70] dark:text-white/55">预估成交后持仓成本 {estCost ? `${estCost.toFixed(2)} ${cur}` : `0.00 ${cur}`}</div>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className={className(
              "ml-auto inline-flex h-10 flex-none items-center gap-2 whitespace-nowrap rounded-lg px-4 text-xs font-bold text-white transition-all active:scale-[.98] disabled:opacity-60 sm:px-6 sm:text-sm",
              isBuy ? "bg-[#ff8a5c] hover:bg-[#ff9d72] dark:bg-[#ff6a3d] dark:hover:bg-[#ff7f57]" : "bg-[#37c98a] hover:bg-[#4fd9a0] dark:bg-[#00a985] dark:hover:bg-[#12bd97]"
            )}
          >
            {submitting ? "处理中…" : tradeMode === "record" ? `记录${isBuy ? "买入" : "卖出"}成交` : `提交${isBuy ? "买入" : "卖出"}委托`}
          </button>
          </div>
        </div>
      </div>
  );
}

/* ---------- 小部件 ---------- */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-[#8a8a8a] dark:text-white/60">{label}</label>
      {children}
    </div>
  );
}
function Dropdown({ value, open, onToggle, onClose, btnCls, children }: { value: string; open: boolean; onToggle: () => void; onClose: () => void; btnCls?: string; children: ReactNode }) {
  return (
    <div className="relative">
      <button type="button" className={btnCls} onClick={onToggle}><span className="tabular-nums">{value}</span><Chevron /></button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onClose} />
          <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-[#ececef] dark:border-white/12 bg-white dark:bg-[#0d1418] shadow-xl">{children}</div>
        </>
      )}
    </div>
  );
}
function MenuItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={className("block w-full px-3 py-2 text-left text-xs transition-colors", active ? "bg-[#eef3fb] text-[#1d1d1f] dark:bg-[#1e293b] dark:text-white" : "text-[#6b6b70] hover:bg-black/5 hover:text-[#1d1d1f] dark:text-white/70 dark:hover:bg-white/5 dark:hover:text-white")}>
      {children}
    </button>
  );
}
function Calendar({ month, onMonth, value, onPick, onClose }: { month: { y: number; m: number }; onMonth: (m: { y: number; m: number }) => void; value: string; onPick: (d: string) => void; onClose: () => void }) {
  const { y, m } = month;
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  const wk = ["日", "一", "二", "三", "四", "五", "六"];
  const ds = (d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute bottom-full left-1/2 z-20 mb-1 w-[252px] -translate-x-1/2 overflow-hidden rounded-xl border border-[#ececef] bg-white p-2 shadow-2xl dark:border-white/12 dark:bg-[#0d1418]">
        <div className="flex items-center justify-between px-1 pb-1.5">
          <span className="text-sm font-semibold text-[#1d1d1f] dark:text-white">有效期</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onMonth(m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 })} className="grid h-6 w-6 place-items-center rounded-full text-[#6b6b70] hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10">‹</button>
            <span className="text-sm tabular-nums text-[#1d1d1f] dark:text-white">{y}.{String(m + 1).padStart(2, "0")}</span>
            <button type="button" onClick={() => onMonth(m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 })} className="grid h-6 w-6 place-items-center rounded-full text-[#6b6b70] hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10">›</button>
          </div>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-[#8a8a8a] dark:text-white/50">{wk.map((w) => <span key={w} className="py-1">{w}</span>)}</div>
        <div className="grid grid-cols-7 text-center text-sm">
          {cells.map((d, i) => {
            const sel = d ? ds(d) : "";
            const isSel = sel === value;
            const isToday = sel === today;
            return (
              <button key={i} type="button" disabled={!d} onClick={() => d && onPick(ds(d))} className={className("mx-0.5 my-0.5 grid h-7 place-items-center rounded-full text-[13px] tabular-nums transition-colors", !d ? "invisible" : isSel ? "bg-[#2f6fed] font-semibold text-white" : isToday ? "font-semibold text-[#2f6fed]" : "text-[#1d1d1f] hover:bg-black/5 dark:text-white/80 dark:hover:bg-white/10")}>
                {d ?? ""}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
function Chevron() {
  return <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m2 4 4 4 4-4" /></svg>;
}


function usableMinUnit(market: string) {
  const m = (market || "").toUpperCase();
  // 美股/港股/日股等允许碎股；A股整手 100
  return m === "CN" || m === "CHN" ? 100 : 0.0001;
}
function priceStep(market: string) {
  const m = (market || "").toUpperCase();
  if (m === "CN") return 0.01;
  if (m === "HK") return 0.01;
  return 0.01;
}
function round(n: number, p: number) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
function fmtP(n: number) {
  return round(Math.max(0, n), 2).toFixed(2);
}
