"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import AppModal from "@/components/AppModal";
import { showToast } from "@/lib/toast";
import { usePersistedState } from "@/lib/usePersistedState";
import { CARD_CURRENCIES, cardLast4, currencySymbol, fmtCardMoney, formatCardNumber } from "@/lib/cardCurrencies";

/** 卡包里的一张卡：卡面 + 卡背信息 + 当前余额 */
export interface WalletCard {
  key: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
  image: string;
  amount: number;
  currency: string;
  /** 是否录入过金额（没录入过时余额显示占位而不是 0） */
  hasAmount: boolean;
  number: string;
  expiry: string;
  cvv: string;
  note: string;
}

export interface WalletCardDetails {
  cardKey: string;
  number: string;
  expiry: string;
  cvv: string;
  note: string;
  currency: string;
  updatedAt: string;
}

interface BalanceEntry {
  id: string;
  cardKey: string;
  kind: "deposit" | "withdraw" | "adjust";
  delta: number;
  balance: number;
  note: string;
  occurredAt: string;
}

type SortKey = "custom" | "bank" | "balance" | "name";

const SORT_LABEL: Record<SortKey, string> = { custom: "默认顺序", bank: "按银行", balance: "按余额", name: "按卡名" };
const CARD_STEP = 30;
const CARD_SCALE_STEP = 0.055;
const FLY_OUT = -300;
const FOCUS_RING =
  "focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.15)] focus:outline-none dark:focus:border-white/20 dark:focus:shadow-[0_0_0_3px_rgba(255,255,255,.10)]";

function StackGlyph({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="4" y="8" width="15" height="10" rx="2.4" />
      <path d="M7.4 5.6h12.2a1.8 1.8 0 0 1 1.8 1.8v7.2" />
    </svg>
  );
}

function IconButton({
  label,
  onClick,
  active = false,
  children
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-9 w-9 place-items-center rounded-full border transition-colors duration-200 ${
        active
          ? "border-white/25 bg-white/12 text-white"
          : "border-white/15 bg-white/[0.06] text-white/70 hover:border-white/30 hover:bg-white/12 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function fmtEntryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const weekday = date.toLocaleDateString("zh-CN", { weekday: "short" });
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${md} ${weekday} ${time}`;
}

function localDateInput(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 卡包：整屏堆叠卡片，上下滑动切换。
 * 拖动时卡片跟手，松手后按距离 + 速度判定，用 GSAP 缓动把整叠卡片推到下一个位置。
 */
export default function CardWalletStack({
  cards,
  onClose,
  onAddCards,
  onAmountChange,
  onDetailsSaved
}: {
  cards: WalletCard[];
  onClose: () => void;
  onAddCards: () => void;
  onAmountChange: (cardKey: string, amount: number, currency: string) => void;
  onDetailsSaved: (details: WalletCardDetails) => void;
}) {
  const [sort, setSort] = usePersistedState<SortKey>("fire:card-wallet-sort", "custom");
  const [sortOpen, setSortOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [entriesByCard, setEntriesByCard] = useState<Record<string, BalanceEntry[]>>({});
  const [entriesLoading, setEntriesLoading] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  /** 已经画过位置的卡片：新挂载的那些要直接落位，不走过渡 */
  const paintedRef = useRef(new Set<string>());
  const dragRef = useRef<{ id: number; startY: number; startAt: number } | null>(null);
  const offsetRef = useRef(0);
  const movedRef = useRef(false);
  const wheelLockRef = useRef(0);

  const sorted = useMemo(() => {
    const list = [...cards];
    if (sort === "bank") list.sort((a, b) => a.bank.localeCompare(b.bank, "zh-Hans-CN") || a.name.localeCompare(b.name, "zh-Hans-CN"));
    else if (sort === "balance") list.sort((a, b) => b.amount - a.amount || a.bank.localeCompare(b.bank, "zh-Hans-CN"));
    else if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    return list;
  }, [cards, sort]);

  const indexRef = useRef(0);
  const sortedRef = useRef<WalletCard[]>(sorted);
  const detailCard = useMemo(() => sorted.find((card) => card.key === detailKey) ?? null, [sorted, detailKey]);
  const current = sorted[Math.min(index, Math.max(0, sorted.length - 1))] ?? null;

  useEffect(() => {
    sortedRef.current = sorted;
  }, [sorted]);

  useEffect(() => {
    indexRef.current = Math.min(indexRef.current, Math.max(0, sorted.length - 1));
    setIndex((value) => Math.min(value, Math.max(0, sorted.length - 1)));
  }, [sorted.length]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /** 叠放位置：第 0 张在最上面，后面的依次下沉、缩小；划走的卡向上飞出 */
  const transformFor = useCallback((relative: number, drag: number) => {
    if (relative === 0) {
      return { y: drag, scale: 1 - Math.min(Math.abs(drag) / 2600, 0.05), opacity: 1, z: 200 };
    }
    if (relative < 0) {
      return { y: FLY_OUT + (relative + 1) * 46 + drag * 0.7, scale: 0.98, opacity: 0, z: 190 + relative };
    }
    const depth = Math.min(relative, 5);
    return {
      y: depth * CARD_STEP + drag * (depth === 1 ? 0.34 : 0.16 / depth),
      scale: Math.pow(1 - CARD_SCALE_STEP, depth),
      opacity: depth > 3 ? 0 : 1 - Math.max(0, depth - 2) * 0.4,
      z: 200 - depth
    };
  }, []);

  /** 把当前 index / 拖动偏移画到 DOM 上；animate = true 时用缓动过渡 */
  const paint = useCallback(
    (drag: number, animate: boolean) => {
      const list = sortedRef.current;
      const base = indexRef.current;
      const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      list.forEach((card, i) => {
        const element = itemRefs.current.get(card.key);
        if (!element) return;
        const relative = i - base;
        if (relative < -1 || relative > 4) {
          gsap.set(element, { autoAlpha: 0 });
          return;
        }
        const target = transformFor(relative, drag);
        // 新挂载的卡片（前进时从叠底补位进来）直接落到目标位：否则 gsap.to 会从 DOM
        // 默认位（正中）一路滑过去，看起来像从最上面那张卡里钻出来再缩回去
        const fresh = !paintedRef.current.has(card.key);
        paintedRef.current.add(card.key);
        const vars = { y: target.y, scale: target.scale, autoAlpha: target.opacity, zIndex: target.z };
        // 跟手拖动 / 首帧定位 / 新挂载补位：都要立刻生效（overwrite 顺手掐掉还在跑的过渡，
        // 否则上一步的缓动会和手指抢同一个属性）
        if (!animate || reduced || fresh) {
          gsap.set(element, { ...vars, overwrite: true });
          return;
        }
        gsap.to(element, {
          ...vars,
          duration: relative < 0 ? 0.4 : 0.58,
          ease: relative < 0 ? "power2.in" : "power4.out",
          overwrite: true
        });
      });
    },
    [transformFor]
  );

  useLayoutEffect(() => {
    indexRef.current = index;
    paint(0, true);
  }, [index, sorted, paint]);

  // 首次进入：整叠卡片轻微上浮 + 淡入（用 layout effect 在绘制前就把卡片压到初始位，
  // 否则 useEffect 在绘制后才跑，首帧会先闪一帧「所有卡片叠在中间」再开始上浮）
  useLayoutEffect(() => {
    const nodes = [...itemRefs.current.values()];
    if (nodes.length === 0) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    gsap.fromTo(
      nodes,
      { y: 46, autoAlpha: 0 },
      { y: (i) => transformFor(i, 0).y, autoAlpha: (i) => transformFor(i, 0).opacity, duration: 0.62, ease: "power3.out", stagger: 0.04, overwrite: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = useCallback(
    (direction: number) => {
      const max = Math.max(0, sortedRef.current.length - 1);
      const next = Math.max(0, Math.min(max, indexRef.current + direction));
      if (next === indexRef.current) {
        paint(0, true);
        return;
      }
      indexRef.current = next;
      setIndex(next);
      paint(0, true);
    },
    [paint]
  );

  const onWindowMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.id) return;
      const max = sortedRef.current.length - 1;
      let delta = event.clientY - drag.startY;
      // 已经是第一张还往下拖 / 最后一张还往上拖：阻尼回弹
      if ((indexRef.current === 0 && delta > 0) || (indexRef.current === max && delta < 0)) delta *= 0.3;
      if (Math.abs(delta) > 6) movedRef.current = true;
      offsetRef.current = delta;
      paint(delta, false);
    },
    [paint]
  );

  const onWindowUp = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.id) return;
      dragRef.current = null;
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
      const delta = offsetRef.current;
      offsetRef.current = 0;
      const elapsed = Math.max(1, performance.now() - drag.startAt);
      const velocity = delta / elapsed;
      const threshold = 96;
      if (delta < -threshold || (delta < -26 && velocity < -0.5)) step(1);
      else if (delta > threshold || (delta > 26 && velocity > 0.5)) step(-1);
      else paint(0, true);
      window.setTimeout(() => {
        movedRef.current = false;
      }, 0);
    },
    [onWindowMove, paint, step]
  );

  const onStagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (sorted.length < 2 || detailKey) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragRef.current = { id: event.pointerId, startY: event.clientY, startAt: performance.now() };
    offsetRef.current = 0;
    movedRef.current = false;
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowUp);
  };

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onWindowMove);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
    },
    [onWindowMove, onWindowUp]
  );

  const requestClose = useCallback(() => {
    if (closing) return;
    const node = overlayRef.current;
    if (!node) {
      onClose();
      return;
    }
    setClosing(true);
    gsap.to(node, {
      autoAlpha: 0,
      duration: 0.18,
      ease: "power2.in",
      onComplete: () => onClose()
    });
  }, [closing, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (detailKey) setDetailKey(null);
        else requestClose();
        return;
      }
      if (detailKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailKey, requestClose, step]);

  const onStageWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const now = performance.now();
    if (now < wheelLockRef.current) return;
    if (Math.abs(event.deltaY) < 10) return;
    wheelLockRef.current = now + 420;
    step(event.deltaY > 0 ? 1 : -1);
  };

  const onCardClick = (position: number) => {
    if (movedRef.current) return;
    if (position === indexRef.current) {
      setDetailKey(sortedRef.current[position]?.key ?? null);
      return;
    }
    indexRef.current = position;
    setIndex(position);
    paint(0, true);
  };

  async function loadEntries(cardKey: string) {
    setEntriesLoading(true);
    try {
      const res = await fetch(`/api/cards/wallet?cardKey=${encodeURIComponent(cardKey)}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (!data) throw new Error("load failed");
      setEntriesByCard((prev) => ({ ...prev, [cardKey]: Array.isArray(data.entries) ? (data.entries as BalanceEntry[]) : [] }));
      if (data.details) onDetailsSaved(data.details as WalletCardDetails);
    } catch {
      showToast("余额历史加载失败", "err");
    } finally {
      setEntriesLoading(false);
    }
  }

  useEffect(() => {
    if (!detailKey) return;
    if (entriesByCard[detailKey]) return;
    void loadEntries(detailKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailKey]);

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[9995] flex flex-col bg-[#06070a] text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(82,116,182,.28),rgba(6,7,10,0))]" />

      <div className="relative flex items-center gap-2.5 px-5 pb-1 pt-5">
        <h2 className="mr-auto text-[22px] font-extrabold tracking-tight">卡包</h2>
        <span className="grid h-9 w-9 place-items-center rounded-full border border-white/25 bg-white/12 text-white">
          <StackGlyph />
        </span>
        <span className="relative">
          <IconButton label="排序" active={sortOpen} onClick={() => setSortOpen((open) => !open)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M7 4v16M7 4 4 7.4M7 4l3 3.4M17 20V4M17 20l3-3.4M17 20l-3-3.4" />
            </svg>
          </IconButton>
          {sortOpen && (
            <>
              <span className="fixed inset-0 z-10 block" onClick={() => setSortOpen(false)} />
              <span className="absolute right-0 top-full z-20 mt-2 block min-w-[140px] overflow-hidden rounded-xl border border-white/12 bg-[#15171d] p-1 shadow-2xl">
                {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSort(key);
                      setSortOpen(false);
                      indexRef.current = 0;
                      setIndex(0);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                      sort === key ? "bg-white/12 font-semibold text-white" : "text-white/70 hover:bg-white/8 hover:text-white"
                    }`}
                  >
                    {SORT_LABEL[key]}
                    {sort === key && (
                      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                        <path d="m2.4 6.4 2.5 2.5 4.7-5.8" />
                      </svg>
                    )}
                  </button>
                ))}
              </span>
            </>
          )}
        </span>
        <IconButton label="回到卡面库列表" onClick={requestClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M4 7h16M4 12h16M4 17h10" />
          </svg>
        </IconButton>
        <IconButton
          label="添加卡片"
          onClick={() => {
            onAddCards();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </IconButton>
      </div>

      {sorted.length === 0 ? (
        <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <p className="text-sm text-white/60">卡包里还没有卡 —— 先去卡面库挑一张加入我的卡</p>
          <button
            type="button"
            onClick={onAddCards}
            className="rounded-full bg-white px-5 py-2.5 text-xs font-semibold text-[#0b0d12] transition-transform duration-200 hover:-translate-y-px"
          >
            去挑一张卡
          </button>
        </div>
      ) : (
        <>
          <div
            className="relative flex-1 touch-none select-none"
            onPointerDown={onStagePointerDown}
            onWheel={onStageWheel}
          >
            {sorted.map((card, i) => {
              const relative = i - index;
              if (relative < -1 || relative > 4) return null;
              return (
                <div key={card.key} className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div
                    ref={(element) => {
                      if (element) {
                        itemRefs.current.set(card.key, element);
                      } else {
                        itemRefs.current.delete(card.key);
                        paintedRef.current.delete(card.key);
                      }
                    }}
                    style={{ zIndex: 200 - Math.max(0, relative) }}
                    className="pointer-events-auto w-[min(84vw,340px)] will-change-transform"
                  >
                    <button
                      type="button"
                      onClick={() => onCardClick(i)}
                      className="relative block w-full overflow-hidden rounded-[16px] shadow-[0_20px_46px_rgba(0,0,0,.62)] ring-1 ring-white/12 transition-shadow duration-200"
                    >
                      <img src={`/uploads/cards/${card.image}`} alt={card.name} draggable={false} className="aspect-[1.586] w-full object-cover" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="relative flex flex-col items-center gap-1 px-6 pb-2 text-center">
            <p className="text-[13px] font-semibold text-white/85">
              {current?.bank}
              <span className="mx-1.5 text-white/25">·</span>
              <span className="text-white/60">{current?.name}</span>
            </p>
            <p className="text-[15px] font-bold tabular-nums text-white">
              {current && current.hasAmount ? fmtCardMoney(current.amount, current.currency) : <span className="text-[12px] font-medium text-white/40">还没有录入余额</span>}
            </p>
            <p className="mt-1 text-[11px] text-white/35">
              上滑 / 下滑切换卡片 · 点按最上面的卡看卡背与余额历史
              {sorted.length > 1 ? ` · ${index + 1}/${sorted.length}` : ""}
            </p>
          </div>
        </>
      )}

      <div className="relative flex items-center justify-center pb-6 pt-1">
        <button
          type="button"
          onClick={requestClose}
          aria-label="关闭卡包"
          className="grid h-12 w-12 place-items-center rounded-full border border-white/12 bg-white/[0.06] text-white transition-colors duration-200 hover:bg-white/12"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {detailCard && (
        <CardDetailPanel
          card={detailCard}
          entries={entriesByCard[detailCard.key] ?? []}
          loading={entriesLoading && !entriesByCard[detailCard.key]}
          onBack={() => setDetailKey(null)}
          onAmountChange={onAmountChange}
          onDetailsSaved={onDetailsSaved}
          onEntryAdded={(entry, balance) => {
            setEntriesByCard((prev) => ({
              ...prev,
              [detailCard.key]: [entry, ...(prev[detailCard.key] ?? [])].sort(
                (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)
              )
            }));
            onAmountChange(detailCard.key, balance, detailCard.currency);
          }}
          onEntryDeleted={() => void loadEntries(detailCard.key)}
        />
      )}
    </div>
  );
}

/** 单张卡：正面（卡面素材）/ 反面（磁条 + 签名栏 + 安全码 + 有效期）翻转 */
function CardFaces({ card, side, onFlip, reveal }: { card: WalletCard; side: "front" | "back"; onFlip: () => void; reveal: boolean }) {
  const last4 = cardLast4(card.number);
  const back = (
    <div className="absolute inset-0 overflow-hidden rounded-[16px] border border-white/12 bg-[linear-gradient(152deg,#232832,#0b0d12_62%)] [backface-visibility:hidden] [transform:rotateY(180deg)]">
      <div className="flex items-start justify-between px-5 pt-4">
        <span className="text-[13px] font-semibold text-white/85">{card.bank}</span>
        <span className="text-[11px] text-white/45">
          {card.type || "银行卡"}
          {card.brand ? ` · ${card.brand}` : ""}
        </span>
      </div>
      <div className="mt-4 h-[16%] w-full bg-[repeating-linear-gradient(180deg,#04050a_0,#04050a_2px,#171a22_3px,#04050a_4px)]" />
      <div className="mt-4 flex items-stretch gap-3 px-5">
        <div className="flex h-9 flex-1 items-center rounded-[4px] bg-[repeating-linear-gradient(180deg,#f6f6f7_0,#f6f6f7_7px,#e2e2e6_8px,#f6f6f7_9px)] px-3">
          <span className="truncate text-[10px] italic text-[#3f3f46]">{card.name}</span>
        </div>
        <div className="min-w-[70px] rounded-[6px] bg-white px-3 py-1 text-center">
          <span className="block text-[9px] font-semibold uppercase tracking-wider text-[#71717a]">CVV</span>
          <b className="text-[15px] font-bold italic tabular-nums text-[#18181b]">{reveal ? card.cvv || "———" : "•••"}</b>
        </div>
      </div>
      <div className="mt-auto flex items-end justify-between px-5 pb-4 pt-5">
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-white/40">有效期</span>
          <b className="text-[13px] tabular-nums text-white/85">{reveal ? card.expiry || "—/—" : "••/••"}</b>
        </div>
        <div className="text-right">
          <span className="block text-[9px] uppercase tracking-wide text-white/40">卡号</span>
          <b className="text-[13px] tabular-nums text-white/85">{reveal ? formatCardNumber(card.number) || "——" : `•••• ${last4 || "••••"}`}</b>
        </div>
      </div>
    </div>
  );
  return (
    <button type="button" onClick={onFlip} className="relative block w-full [perspective:1400px]" aria-label="翻转卡片">
      <div
        className="relative aspect-[1.586] w-full transition-transform duration-[620ms] ease-[cubic-bezier(.22,.61,.36,1)] [transform-style:preserve-3d]"
        style={{ transform: side === "back" ? "rotateY(180deg)" : "rotateY(0deg)" }}
      >
        <div className="absolute inset-0 overflow-hidden rounded-[16px] shadow-[0_18px_40px_rgba(0,0,0,.55)] ring-1 ring-white/12 [backface-visibility:hidden]">
          <img src={`/uploads/cards/${card.image}`} alt={card.name} draggable={false} className="h-full w-full object-cover" />
        </div>
        {back}
      </div>
    </button>
  );
}

/** 卡片详情：卡面 + 卡背信息 + 余额历史（存钱 / 取钱 / 调整） */
function CardDetailPanel({
  card,
  entries,
  loading,
  onBack,
  onAmountChange,
  onDetailsSaved,
  onEntryAdded,
  onEntryDeleted
}: {
  card: WalletCard;
  entries: BalanceEntry[];
  loading: boolean;
  onBack: () => void;
  onAmountChange: (cardKey: string, amount: number, currency: string) => void;
  onDetailsSaved: (details: WalletCardDetails) => void;
  onEntryAdded: (entry: BalanceEntry, balance: number) => void;
  onEntryDeleted: () => void;
}) {
  const [side, setSide] = useState<"front" | "back">("front");
  const [reveal, setReveal] = useState(true);
  const [form, setForm] = useState<null | "deposit" | "withdraw" | "adjust" | "edit">(null);
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => localDateInput());
  const [draft, setDraft] = useState({ number: "", expiry: "", cvv: "", note: "", currency: "CNY" });

  useEffect(() => {
    setSide("front");
  }, [card.key]);

  function openForm(kind: "deposit" | "withdraw" | "adjust" | "edit") {
    setAmount(kind === "adjust" ? (card.hasAmount ? String(card.amount) : "") : "");
    setNote("");
    setOccurredAt(localDateInput());
    setDraft({
      number: card.number,
      expiry: card.expiry,
      cvv: card.cvv,
      note: card.note,
      currency: card.currency || "CNY"
    });
    setForm(kind);
  }

  async function submitEntry(kind: "deposit" | "withdraw" | "adjust") {
    const value = Number(amount);
    if (!Number.isFinite(value) || (kind === "adjust" ? value < 0 : value <= 0)) {
      showToast("请输入有效金额", "err");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/cards/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardKey: card.key,
          kind,
          amount: value,
          currentBalance: kind === "adjust" ? value : undefined,
          note,
          occurredAt: occurredAt ? new Date(`${occurredAt}T12:00:00`).toISOString() : undefined
        })
      });
      const data = res.ok ? await res.json() : null;
      if (!res.ok || !data?.entry) throw new Error("save failed");
      onEntryAdded(data.entry as BalanceEntry, Number(data.balance) || 0);
      showToast(kind === "deposit" ? "已记一笔存钱" : kind === "withdraw" ? "已记一笔取钱" : "余额已调整");
      setForm(null);
    } catch {
      showToast("保存失败，稍后再试", "err");
    } finally {
      setSaving(false);
    }
  }

  async function submitDetails() {
    setSaving(true);
    try {
      const res = await fetch("/api/cards/wallet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardKey: card.key,
          number: draft.number,
          expiry: draft.expiry,
          cvv: draft.cvv,
          note: draft.note,
          currency: draft.currency
        })
      });
      const data = res.ok ? await res.json() : null;
      if (!res.ok || !data?.details) throw new Error("save failed");
      onDetailsSaved(data.details as WalletCardDetails);
      if (card.hasAmount) onAmountChange(card.key, card.amount, draft.currency);
      showToast("卡片信息已保存");
      setForm(null);
    } catch {
      showToast("保存失败，稍后再试", "err");
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(id: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/cards/wallet?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      const data = await res.json();
      onAmountChange(card.key, Number(data.balance) || 0, card.currency);
      showToast("已删除这笔记录");
      onEntryDeleted();
    } catch {
      showToast("删除失败，稍后再试", "err");
    } finally {
      setSaving(false);
    }
  }

  const last4 = cardLast4(card.number);
  const balanceText = card.hasAmount ? fmtCardMoney(card.amount, card.currency) : "—";
  const rows: [string, React.ReactNode][] = [
    ["当前余额", <b key="balance" className="text-[15px] font-semibold tabular-nums text-white">{balanceText}</b>],
    ["机构", card.bank],
    ["尾号", last4 ? `•••• ${last4}` : "—"],
    ["卡号", reveal ? formatCardNumber(card.number) || "—" : "•••• •••• •••• ••••"],
    ["有效期", reveal ? card.expiry || "—" : "••/••"],
    ["安全码", reveal ? card.cvv || "—" : "•••"],
    ["类型", card.type || "—"],
    ["货币", card.currency || "—"],
    ["备注", card.note || "—"]
  ];

  return (
    <div className="fixed inset-0 z-[9998] flex flex-col bg-[#06070a] text-white">
      <div className="flex items-center gap-3 px-4 py-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回卡包"
          className="grid h-9 w-9 place-items-center rounded-full border border-white/12 bg-white/[0.06] text-white/80 transition-colors duration-200 hover:bg-white/12 hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </button>
        <p className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold">{card.bank}</p>
        <button
          type="button"
          onClick={() => openForm("edit")}
          aria-label="编辑卡片信息"
          className="grid h-9 w-9 place-items-center rounded-full border border-white/12 bg-white/[0.06] text-white/80 transition-colors duration-200 hover:bg-white/12 hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M4 20h4l10-10-4-4L4 16v4Z" />
            <path d="m14.5 5.5 4 4" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-10">
        <div className="mx-auto w-full max-w-[520px]">
          <CardFaces card={card} side={side} reveal={reveal} onFlip={() => setSide((value) => (value === "front" ? "back" : "front"))} />
          <div className="mt-3 flex items-center justify-center gap-2">
            {(["front", "back"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-label={value === "front" ? "正面" : "反面"}
                onClick={() => setSide(value)}
                className={`h-1.5 rounded-full transition-all duration-300 ${side === value ? "w-4 bg-white" : "w-1.5 bg-white/30"}`}
              />
            ))}
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl bg-[#131317]">
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-[11px] text-white/45">卡片信息</span>
              <button
                type="button"
                onClick={() => setReveal((value) => !value)}
                className="text-[11px] font-semibold text-white/60 transition-colors hover:text-white"
              >
                {reveal ? "隐藏卡号 / 安全码" : "显示卡号 / 安全码"}
              </button>
            </div>
            {rows.map(([label, value], rowIndex) => (
              <div key={label} className={`flex items-center gap-3 px-4 py-3 ${rowIndex > 0 ? "border-t border-white/[0.06]" : ""}`}>
                <span className="w-[76px] flex-none text-[13px] text-white/45">{label}</span>
                <span className="min-w-0 flex-1 text-right text-[13px] text-white/90">{value}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl bg-[#131317]">
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <span className="text-[13px] font-semibold text-white/85">余额历史</span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openForm("deposit")}
                  className="rounded-full bg-[#1f8f4e] px-3.5 py-1.5 text-[12px] font-semibold text-white transition-transform duration-200 hover:-translate-y-px"
                >
                  存钱
                </button>
                <button
                  type="button"
                  onClick={() => openForm("withdraw")}
                  className="rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-[12px] font-semibold text-white/85 transition-colors duration-200 hover:bg-white/12"
                >
                  取钱
                </button>
                <button
                  type="button"
                  onClick={() => openForm("adjust")}
                  title="把余额直接改成某个数（首次录入也用它）"
                  className="rounded-full px-2 py-1.5 text-[12px] font-semibold text-white/45 transition-colors duration-200 hover:text-white"
                >
                  调整
                </button>
              </span>
            </div>
            {loading ? (
              <div className="border-t border-white/[0.06] px-4 py-8 text-center text-[12px] text-white/35">余额历史加载中…</div>
            ) : entries.length === 0 ? (
              <div className="border-t border-white/[0.06] px-4 py-8 text-center text-[12px] text-white/35">
                还没有余额记录 —— 点「存钱」记第一笔，或点「调整」直接把当前余额填上
              </div>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="group flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[13px] font-semibold text-white">
                      {entry.kind === "deposit" ? "存钱" : entry.kind === "withdraw" ? "取钱" : "余额调整"}
                      <b className={`tabular-nums ${entry.delta >= 0 ? "text-[#4ade80]" : "text-[#f87171]"}`}>
                        {entry.delta >= 0 ? "+" : "-"}
                        {fmtCardMoney(Math.abs(entry.delta), card.currency)}
                      </b>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-white/40">
                      {fmtEntryDate(entry.occurredAt)}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-2">
                    <b className="text-[13px] font-semibold tabular-nums text-white/90">{fmtCardMoney(entry.balance, card.currency)}</b>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void removeEntry(entry.id)}
                      aria-label="删除这笔记录"
                      className="grid h-6 w-6 place-items-center rounded-full text-white/25 opacity-0 transition-opacity duration-200 hover:bg-white/10 hover:text-white/70 group-hover:opacity-100 disabled:opacity-30"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
                        <path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V5h6v2" />
                      </svg>
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>

          <p className="mt-4 text-center text-[11px] text-white/30">
            卡号 / 有效期 / 安全码只存在你自己的数据库里，用来在卡背显示；余额历史与卡面库的金额是同一份数据。
            借记卡 / 预付卡余额同时算作现金，会计入资产分析的可用现金与净资产；信用卡的金额是额度，不计入。
          </p>
        </div>
      </div>

      {form === "deposit" || form === "withdraw" || form === "adjust" ? (
        <AppModal
          title={form === "deposit" ? "存钱" : form === "withdraw" ? "取钱" : "调整余额"}
          desc={
            form === "adjust"
              ? `${card.bank} ${card.name} · 直接把当前余额改成这个数`
              : `${card.bank} ${card.name} · 当前 ${card.hasAmount ? fmtCardMoney(card.amount, card.currency) : "—"}`
          }
          onClose={() => setForm(null)}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">{form === "adjust" ? "调整后的余额" : form === "deposit" ? "存钱金额" : "取钱金额"}</span>
            <span className="flex items-center gap-2 rounded-xl border border-edge bg-white px-3 transition-all duration-200 focus-within:border-edge-strong dark:bg-[#1c222d]">
              <span className="text-sm font-semibold text-muted">{currencySymbol(card.currency)}</span>
              <input
                autoFocus
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
                inputMode="decimal"
                placeholder="0.00"
                className="h-11 w-full bg-transparent text-[15px] tabular-nums text-ink outline-none placeholder:text-faint"
              />
            </span>
          </label>
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">日期</span>
            <input
              type="date"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
              className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] text-ink dark:bg-[#1c222d] ${FOCUS_RING}`}
            />
          </label>
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">备注（可选）</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={100}
              placeholder={form === "deposit" ? "工资 / 还款 / 结汇 …" : form === "withdraw" ? "刷卡 / 转账 …" : "为什么调整"}
              className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] text-ink placeholder:text-faint dark:bg-[#1c222d] ${FOCUS_RING}`}
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="h-10 rounded-xl px-4 text-[13px] font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void submitEntry(form)}
              className="h-10 rounded-xl bg-[#111] px-5 text-[13px] font-semibold text-white transition-transform duration-200 hover:-translate-y-px disabled:opacity-50 dark:bg-white dark:text-[#111]"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </AppModal>
      ) : null}

      {form === "edit" ? (
        <AppModal title="编辑卡片信息" desc={`${card.bank} ${card.name} · 只保存在本地`} onClose={() => setForm(null)}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">卡号</span>
            <input
              value={draft.number}
              onChange={(event) => setDraft((prev) => ({ ...prev, number: event.target.value.replace(/[^\d ]/g, "") }))}
              inputMode="numeric"
              placeholder="6225 8888 8888 8888"
              className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] tabular-nums text-ink placeholder:text-faint dark:bg-[#1c222d] ${FOCUS_RING}`}
            />
          </label>
          <div className="mt-3 flex gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-muted">有效期</span>
              <input
                value={draft.expiry}
                onChange={(event) => setDraft((prev) => ({ ...prev, expiry: event.target.value.replace(/[^\d/]/g, "") }))}
                placeholder="08/29"
                className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] tabular-nums text-ink placeholder:text-faint dark:bg-[#1c222d] ${FOCUS_RING}`}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-muted">安全码</span>
              <input
                value={draft.cvv}
                onChange={(event) => setDraft((prev) => ({ ...prev, cvv: event.target.value.replace(/\D/g, "").slice(0, 4) }))}
                inputMode="numeric"
                placeholder="327"
                className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] tabular-nums text-ink placeholder:text-faint dark:bg-[#1c222d] ${FOCUS_RING}`}
              />
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">币种</span>
            <select
              value={draft.currency}
              onChange={(event) => setDraft((prev) => ({ ...prev, currency: event.target.value }))}
              className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] font-semibold text-ink dark:bg-[#1c222d] ${FOCUS_RING}`}
            >
              {CARD_CURRENCIES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} · {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">备注</span>
            <input
              value={draft.note}
              onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
              maxLength={60}
              placeholder="香港旅行和跨境消费扣账卡"
              className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] text-ink placeholder:text-faint dark:bg-[#1c222d] ${FOCUS_RING}`}
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="h-10 rounded-xl px-4 text-[13px] font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void submitDetails()}
              className="h-10 rounded-xl bg-[#111] px-5 text-[13px] font-semibold text-white transition-transform duration-200 hover:-translate-y-px disabled:opacity-50 dark:bg-white dark:text-[#111]"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </AppModal>
      ) : null}
    </div>
  );
}
