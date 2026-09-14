"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import AppModal from "@/components/AppModal";
import { showToast } from "@/lib/toast";
import { usePersistedState } from "@/lib/usePersistedState";
import AppSelect from "@/components/AppSelect";
import { cardLast4, currencySymbol, fmtCardMoney, formatCardNumber } from "@/lib/cardCurrencies";
import { cardCurrencyChoicesFor, currencyName } from "@/lib/cardCurrency";
import { isFundCurrency } from "@/lib/fundCurrencies";
import { hasSecurityCode } from "@/lib/cardSecurity";
import { cardAssetId } from "@/lib/cardAssets";

/** 卡包里的一张卡：卡面 + 卡背信息 + 当前余额 */
export interface WalletCard {
  key: string;
  name: string;
  bank: string;
  region: string;
  type: string;
  brand: string;
  level: string;
  /** 清单里的卡面文件（相对 /uploads/cards/ 的路径）—— 卡包只用它做 key 与回退 */
  image: string;
  /** 实际展示用的卡面地址：用户上传过就是自定义卡面，否则是清单原图 */
  cover: string;
  amount: number;
  currency: string;
  /** 是否录入过金额（没录入过时余额显示占位而不是 0） */
  hasAmount: boolean;
  number: string;
  expiry: string;
  cvv: string;
  note: string;
  /** 币种范围手动覆盖（'' = 自动推断）：卡包里改币种时按它收窄选项 */
  currencyScope: string;
}

export interface WalletCardDetails {
  cardKey: string;
  number: string;
  expiry: string;
  cvv: string;
  note: string;
  currency: string;
  /** 币种范围手动覆盖（'' = 自动推断），由卡面库那边维护，卡包只负责原样带回 */
  currencyScope: string;
  /** 自定义卡面地址（'' = 用清单原图），同样由卡面库那边维护 */
  image: string;
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
  /** 这笔钱的另一端在券商账户（同时联动记了一笔方向相反的资金流水） */
  brokerLinked?: boolean;
}

type SortKey = "custom" | "bank" | "balance" | "name";

const SORT_LABEL: Record<SortKey, string> = { custom: "默认顺序", bank: "按银行", balance: "按余额", name: "按卡名" };
/** 还没看到的卡：往下每一张露出的高度 */
const CARD_STEP = 30;
const CARD_SCALE_STEP = 0.055;
/** 已经翻过去的卡：往上每一张露出的高度（比下面多一点，翻过去的页看得见） */
const ABOVE_STEP = 44;
const ABOVE_SCALE_STEP = 0.05;
/** 手指拖多远算「完整换一张」：决定整叠往前 / 往后推的进度 */
const SWIPE_DISTANCE = 300;
/** 手里这张最多被拉出来多少：超过就带阻尼，像从一叠卡里抽一张出来 */
const PULL_MAX = 92;
/** 上下各渲染几张（再深的就收进叠里了） */
const VISIBLE_ABOVE = 6;
const VISIBLE_BELOW = 5;
/** 叠得越深，每一张露出的高度越小：卡叠会自己压紧，不会一路顶到标题栏 */
const FAN_COMPRESS = 0.05;
/** 快甩判定：手指速度（px/ms）到这个值就算「一把甩出去」 */
const FLICK_SPEED = 1.6;
const FOCUS_RING =
  "focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.15)] focus:outline-none dark:focus:border-white/20 dark:focus:shadow-[0_0_0_3px_rgba(255,255,255,.10)]";

/**
 * 叠层里第 slot 层离正中多远（往下为正）。slot 可以是小数：拖动时每张卡都在连续换层。
 * 超过两三层之后间距递减，整叠看着像被压紧的一摞卡，而不是一路平铺出去。
 */
function fanOffset(slot: number, step: number): number {
  const compress = 1 / (1 + (FAN_COMPRESS * slot * (slot - 1)) / 2);
  return step * slot * compress;
}

/** 拖动进度：前 30% 的手指位移先走完一半的叠层位移，反应更跟手，尾巴再慢慢收 */
function easeProgress(t: number): number {
  return 1 - Math.pow(1 - t, 1.45);
}

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
  onDetailsSaved,
  onCoverChanged
}: {
  cards: WalletCard[];
  onClose: () => void;
  onAddCards: () => void;
  onAmountChange: (cardKey: string, amount: number, currency: string) => void;
  onDetailsSaved: (details: WalletCardDetails) => void;
  /** 卡包里换了卡面后同步回卡面库（与素材库·卡片是同一张图） */
  onCoverChanged: (cardKey: string, url: string) => void;
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

  /**
   * 叠放位置。这一叠卡是一摞「翻过的卡 + 没翻的卡」，按手指位置连续变形：
   * - 往上拖 = 往前翻（p 从 0 → 1）：手里这张被抽出来一段，翻过去之后摞到上面那摞；
   *   下面整叠顺势往上补位，下一张顶上来。
   * - 往下拖 = 往回翻（q 从 0 → 1）：上面那摞往下走一层，最近翻过的那张落回正中；
   *   手里这张往下沉一级，钻进下面那摞。
   * 翻过去的卡不会消失：它们就叠在卡片上方（越往上越小、越淡，像收进卡叠深处）。
   * p / q 按 SWIPE_DISTANCE 归一化，整叠是连续推进的，松手只是从这里缓动到终点。
   */
  const transformFor = useCallback((relative: number, drag: number) => {
    const p = easeProgress(Math.max(0, Math.min(1, -drag / SWIPE_DISTANCE)));
    const q = easeProgress(Math.max(0, Math.min(1, drag / SWIPE_DISTANCE)));

    // 手里这张：跟手，但拉出来一段之后就带阻尼；被抽出来时略微放大，像从卡叠里抬起来
    if (relative === 0) {
      const pulled = PULL_MAX * (1 - Math.exp(-Math.abs(drag) / PULL_MAX));
      return {
        y: drag >= 0 ? pulled : -pulled,
        scale: 1 + Math.min(pulled / 1400, 0.035),
        opacity: 1,
        // 往下拖时它要让位：翻回来的那张压在上面，这张钻到后面去
        z: q > 0.001 ? 205 : 210
      };
    }

    // 已经翻过去的卡：摞在卡片上方；往前翻再往上走一层，往回翻就落回来一层
    if (relative < 0) {
      const slot = Math.max(0, -relative + p - q);
      return {
        y: -fanOffset(slot, ABOVE_STEP),
        scale: Math.pow(1 - ABOVE_SCALE_STEP, slot),
        opacity: Math.max(0, Math.min(1, 1 - Math.max(0, slot - 3) * 0.28)),
        z: 206 - Math.ceil(slot)
      };
    }

    // 还没看到的卡：往前拖 = 整叠往上补位，往回拖 = 整叠往下沉一级
    const depth = Math.min(relative, 5);
    const shifted = Math.max(0, depth - p + q);
    return {
      y: fanOffset(shifted, CARD_STEP),
      scale: Math.pow(1 - CARD_SCALE_STEP, shifted),
      opacity: Math.max(0, Math.min(1, 1 - Math.max(0, shifted - 2.5) * 0.35)),
      z: 200 - Math.ceil(shifted)
    };
  }, []);

  /**
   * 把当前 index / 拖动偏移画到 DOM 上。
   * animate = true 时用缓动过渡；speed 是松手时的甩动速度（px/ms），甩得越快收得越利落。
   */
  const paint = useCallback(
    (drag: number, animate: boolean, speed = 0) => {
      const list = sortedRef.current;
      const base = indexRef.current;
      const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      list.forEach((card, i) => {
        const element = itemRefs.current.get(card.key);
        if (!element) return;
        const relative = i - base;
        if (relative < -VISIBLE_ABOVE || relative > VISIBLE_BELOW) {
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
        // 离目标越远给的时间越长；甩得越快收得越急；整叠按层数错开一点点，
        // 落位时是一层一层"啪"下来的，不是整块板子一起移动
        const from = Number(gsap.getProperty(element, "y")) || 0;
        const distance = Math.abs(from - target.y);
        const flick = Math.max(0, Math.min(1, speed / FLICK_SPEED));
        const level = Math.min(Math.abs(relative), 3);
        gsap.to(element, {
          ...vars,
          duration: Math.max(0.3, Math.min(0.74, 0.44 + distance / 1600) * (1 - flick * 0.3)),
          delay: level * 0.02 * (1 - flick * 0.6),
          // 位移大的给一点回弹：像卡片"啪"地落进卡叠
          ease: distance > 24 ? "back.out(1.15)" : "power3.out",
          overwrite: "auto"
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
    (direction: number, speed = 1.1) => {
      const max = Math.max(0, sortedRef.current.length - 1);
      const next = Math.max(0, Math.min(max, indexRef.current + direction));
      if (next === indexRef.current) {
        paint(0, true, speed);
        return;
      }
      indexRef.current = next;
      setIndex(next);
      paint(0, true, speed);
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
      const flick = Math.abs(velocity);
      if (delta < -threshold || (delta < -26 && velocity < -0.5)) step(1, flick);
      else if (delta > threshold || (delta > 26 && velocity > 0.5)) step(-1, flick);
      else paint(0, true, flick);
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
    wheelLockRef.current = now + 360;
    // 滚轮冲得越猛越像"甩"：收尾更利落
    step(event.deltaY > 0 ? 1 : -1, Math.min(1.6, Math.abs(event.deltaY) / 120));
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
    <div ref={overlayRef} className="fixed inset-0 z-[9995] flex h-[100dvh] flex-col bg-[#06070a] text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(82,116,182,.28),rgba(6,7,10,0))]" />

      {/* z-20：划走的卡从标题栏后面飞出去，不会盖住这几个按钮 */}
      <div className="relative z-20 flex items-center gap-2.5 px-5 pb-1 pt-[max(1.25rem,env(safe-area-inset-top))]">
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
            className="relative isolate flex-1 touch-none select-none"
            onPointerDown={onStagePointerDown}
            onWheel={onStageWheel}
          >
            {sorted.map((card, i) => {
              const relative = i - index;
              if (relative < -VISIBLE_ABOVE || relative > VISIBLE_BELOW) return null;
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
                      <img src={card.cover} alt={card.name} draggable={false} translate="no" className="aspect-[1.586] w-full object-cover" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="relative flex flex-col items-center gap-1 px-6 pb-2 text-center">
            <p translate="no" className="notranslate text-[13px] font-semibold text-white/85">
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

      <div className="relative flex items-center justify-center pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-1">
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
          onCoverChanged={onCoverChanged}
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
  const showCvv = hasSecurityCode(card);
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
        {/* 大陆借记卡背面没有安全码，这一格不画（签名栏顺势拉满） */}
        {showCvv && (
          <div className="min-w-[70px] rounded-[6px] bg-white px-3 py-1 text-center">
            <span className="block text-[9px] font-semibold uppercase tracking-wider text-[#71717a]">CVV</span>
            <b className="text-[15px] font-bold italic tabular-nums text-[#18181b]">{reveal ? card.cvv || "———" : "•••"}</b>
          </div>
        )}
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
          <img src={card.cover} alt={card.name} draggable={false} translate="no" className="h-full w-full object-cover" />
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
  onCoverChanged,
  onEntryAdded,
  onEntryDeleted
}: {
  card: WalletCard;
  entries: BalanceEntry[];
  loading: boolean;
  onBack: () => void;
  onAmountChange: (cardKey: string, amount: number, currency: string) => void;
  onDetailsSaved: (details: WalletCardDetails) => void;
  onCoverChanged: (cardKey: string, url: string) => void;
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
  /** 这笔钱的另一端在券商账户：勾上会同时记一笔资金流水，避免总现金被重复计算 */
  const [brokerLinked, setBrokerLinked] = useState(false);
  /** 正在上传 / 保存卡面 */
  const [coverSaving, setCoverSaving] = useState(false);
  const [draft, setDraft] = useState({ number: "", expiry: "", cvv: "", note: "", currency: "CNY" });

  useEffect(() => {
    setSide("front");
  }, [card.key]);

  /** 这张卡能记的币种：单币卡只有一个，双币两个，多币种给该地区的常见币种 */
  const currencyChoices = cardCurrencyChoicesFor({
    name: card.name,
    brand: card.brand,
    bank: card.bank,
    region: card.region,
    currencyScope: card.currencyScope,
    current: draft.currency
  });

  function openForm(kind: "deposit" | "withdraw" | "adjust" | "edit") {
    setAmount(kind === "adjust" ? (card.hasAmount ? String(card.amount) : "") : "");
    setNote("");
    setOccurredAt(localDateInput());
    setBrokerLinked(false);
    setDraft({
      number: card.number,
      expiry: card.expiry,
      cvv: card.cvv,
      note: card.note,
      // 币种只在「这张卡能记的币种」里：单币卡就那一个
      currency: currencyChoices.includes(card.currency) ? card.currency : currencyChoices[0] ?? "CNY"
    });
    setForm(kind);
  }

  /**
   * 换卡面：传到素材目录（folder=card）后写进**素材库的卡片素材**（card:{卡面文件}），
   * 与「素材库 → 卡片」里换的是同一条，卡面库同步生效。
   */
  async function uploadCover(file: File) {
    if (coverSaving) return;
    setCoverSaving(true);
    try {
      const form = new FormData();
      form.append("kind", "asset");
      form.append("folder", "card");
      form.append("file", file);
      form.append("name", `${card.bank}${card.name}`);
      form.append("code", card.region || "CARD");
      const uploadRes = await fetch("/api/v1/upload", { method: "POST", body: form });
      const uploadData = await uploadRes.json().catch(() => null);
      const url: string | undefined = uploadData?.data?.url ?? uploadData?.url;
      if (!uploadRes.ok || !url) {
        showToast(uploadData?.message || uploadData?.error || "上传失败，稍后再试", "err");
        return;
      }
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: cardAssetId(card.key),
          type: "card",
          market: card.region,
          code: card.image.split("/").pop()?.replace(/\.[^.]+$/, "") || card.name,
          name: card.name,
          url
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.error || "卡面保存失败，稍后再试", "err");
        return;
      }
      onCoverChanged(card.key, url);
      showToast("卡面已更新");
    } catch {
      showToast("上传失败，稍后再试", "err");
    } finally {
      setCoverSaving(false);
    }
  }

  async function submitEntry(kind: "deposit" | "withdraw" | "adjust") {
    const value = Number(amount);
    if (!Number.isFinite(value) || (kind === "adjust" ? value < 0 : value <= 0)) {
      showToast("请输入有效金额", "err");
      return;
    }
    setSaving(true);
    try {
      const linkBroker = brokerLinked && kind !== "adjust" && isFundCurrency(card.currency);
      const res = await fetch("/api/cards/wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardKey: card.key,
          kind,
          amount: value,
          currentBalance: kind === "adjust" ? value : undefined,
          note,
          occurredAt: occurredAt ? new Date(`${occurredAt}T12:00:00`).toISOString() : undefined,
          fundAccount: linkBroker ? "broker" : undefined,
          fundNote: linkBroker ? `${card.bank} ${card.name}` : undefined
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.entry) {
        // 服务端会说明为什么联动不了（如币种不在资金系统里），别吞掉
        showToast(data?.error || "保存失败，稍后再试", "err");
        return;
      }
      onEntryAdded(data.entry as BalanceEntry, Number(data.balance) || 0);
      showToast(
        kind === "deposit"
          ? linkBroker ? "已记一笔存钱，并在资金记录里记了转出" : "已记一笔存钱"
          : kind === "withdraw"
            ? linkBroker ? "已记一笔取钱，并在资金记录里记了转入" : "已记一笔取钱"
            : "余额已调整"
      );
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
          // 没有安全码的卡（大陆借记卡）不提交这个字段：接口按「只覆盖传入字段」处理，
          // 历史残留的值不会被写回、也不会被这次保存顺手改掉
          ...(showCvv ? { cvv: draft.cvv } : {}),
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
  const showCvv = hasSecurityCode(card);
  const balanceText = card.hasAmount ? fmtCardMoney(card.amount, card.currency) : "—";
  const rows: [string, React.ReactNode][] = [
    ["当前余额", <b key="balance" className="text-[15px] font-semibold tabular-nums text-white">{balanceText}</b>],
    ["机构", card.bank],
    ["尾号", last4 ? `•••• ${last4}` : "—"],
    ["卡号", reveal ? formatCardNumber(card.number) || "—" : "•••• •••• •••• ••••"],
    ["有效期", reveal ? card.expiry || "—" : "••/••"],
    // 大陆借记卡没有安全码，这一行不列
    ...(showCvv ? ([["安全码", reveal ? card.cvv || "—" : "•••"]] as [string, React.ReactNode][]) : []),
    ["类型", card.type || "—"],
    ["货币", card.currency || "—"],
    ["备注", card.note || "—"]
  ];

  return (
    <div className="fixed inset-0 z-[9998] flex h-[100dvh] flex-col bg-[#06070a] text-white">
      <div className="flex items-center gap-3 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
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

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
        <div className="mx-auto w-full max-w-[520px] pt-3">
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
            <div className="flex items-center justify-between gap-2 px-4 py-2.5">
              <span className="text-[11px] text-white/45">卡片信息</span>
              <span className="flex items-center gap-2.5">
                <label
                  className={`cursor-pointer text-[11px] font-semibold text-white/60 transition-colors hover:text-white ${coverSaving ? "pointer-events-none opacity-50" : ""}`}
                  title="换成自己的卡片照片（与素材库·卡片是同一张，卡面库同步生效）"
                >
                  {coverSaving ? "处理中…" : "换卡面"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadCover(file);
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setReveal((value) => !value)}
                  className="text-[11px] font-semibold text-white/45 transition-colors hover:text-white/80"
                  title="也可以点右下角的眼睛"
                >
                  {reveal ? "已显示" : "已隐藏"}
                </button>
              </span>
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
                      {entry.brokerLinked && (
                        <i className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold not-italic text-white/60" title="这笔钱在券商账户里也记了一笔（资金记录里标为「自动」）">
                          券商
                        </i>
                      )}
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
            {showCvv ? "卡号 / 有效期 / 安全码" : "卡号 / 有效期"}只存在你自己的数据库里，用来在卡背显示；余额历史与卡面库的金额是同一份数据。
            借记卡 / 预付卡余额同时算作现金，会计入资产分析的可用现金与净资产；信用卡的金额是额度，不计入。
            {!showCvv ? "中国大陆的借记卡背面没有安全码，这类卡不显示该字段。" : ""}
          </p>
        </div>
      </div>

      {/* 底部：中间关闭按钮（和卡包列表同一个位置、同一个样子），右下角一只眼睛切换卡号 / 安全码的显示 */}
      <div className="relative flex items-center justify-center pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
        <button
          type="button"
          onClick={() => setReveal((value) => !value)}
          aria-label={reveal ? "隐藏卡号与安全码" : "显示卡号与安全码"}
          aria-pressed={reveal}
          title={reveal ? (showCvv ? "隐藏卡号与安全码" : "隐藏卡号") : (showCvv ? "显示卡号与安全码" : "显示卡号")}
          className={`absolute right-4 top-2 grid h-12 w-12 place-items-center rounded-full border transition-colors duration-200 sm:right-5 ${
            reveal ? "border-white/25 bg-white/12 text-white" : "border-white/12 bg-white/[0.06] text-white/55 hover:bg-white/12 hover:text-white"
          }`}
        >
          {reveal ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M4 4.5 20 19.5" />
              <path d="M9.6 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4" />
              <path d="M6.4 7.8A17.2 17.2 0 0 0 2.5 12S6 18.5 12 18.5a9.9 9.9 0 0 0 3.6-.7" />
              <path d="M10.2 10.4a3.2 3.2 0 0 0 4.3 4.4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={onBack}
          aria-label="关闭卡片详情"
          className="grid h-12 w-12 place-items-center rounded-full border border-white/12 bg-white/[0.06] text-white transition-colors duration-200 hover:bg-white/12"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
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
              type="text"
              inputMode="numeric"
              placeholder="YYYY-MM-DD"
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
          {/* 券商账户联动：钱本来就在券商账本里的话，卡里多一笔、券商就少一笔；
              不勾的话两边各记一份，资产分析里的总现金会翻倍 */}
          {form !== "adjust" && isFundCurrency(card.currency) && (
            <div className="mt-3 flex items-start gap-3 rounded-xl border border-edge bg-bg-gray px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
              <button
                type="button"
                role="switch"
                aria-checked={brokerLinked}
                onClick={() => setBrokerLinked((value) => !value)}
                title={brokerLinked ? "点击改为外部资金" : "点击标记为券商账户往来"}
                className={`relative mt-0.5 h-[20px] w-[36px] flex-none rounded-full transition-colors duration-300 ease-out ${
                  brokerLinked ? "bg-[#34c759]" : "bg-[#e9e9eb] dark:bg-[#3a3a3c]"
                }`}
              >
                <span
                  className={`absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform duration-300 ${
                    brokerLinked ? "translate-x-[18px]" : "translate-x-[2px]"
                  }`}
                  style={{ backgroundColor: "#ffffff", transitionTimingFunction: "cubic-bezier(.32,.72,0,1)" }}
                />
              </button>
              <span className="min-w-0 flex-1 text-[12px] leading-5 text-ink-2">
                {form === "deposit" ? "这笔钱是从券商账户转来的" : "这笔钱转回券商账户"}
                <i className="mt-0.5 block not-italic text-[11px] text-muted">
                  会同时在资金记录里记一笔 {card.currency}
                  {form === "deposit" ? " 转出" : " 转入"}（标为自动），券商现金与卡余额不会重复计算
                </i>
              </span>
            </div>
          )}
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
            {/* 中国大陆的借记卡没有安全码，不给这个输入框（有效期独占一行） */}
            {showCvv && (
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
            )}
          </div>
          <label className="mt-3 flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">币种</span>
            {currencyChoices.length > 1 ? (
              <AppSelect value={draft.currency} onChange={(value) => setDraft((prev) => ({ ...prev, currency: value }))} options={currencyChoices.map((code) => ({ value: code, label: `${code} · ${currencyName(code)}` }))} className={`h-10 rounded-xl border border-edge bg-white px-3 text-[13px] font-semibold text-ink dark:bg-[#1c222d] ${FOCUS_RING}`} ariaLabel="币种" />
            ) : (
              <span
                title="单币卡：这张卡只有这一个币种（可在卡面库的卡片详情里改币种范围）"
                className="flex h-10 items-center rounded-xl border border-edge bg-bg-gray px-3 text-[13px] font-semibold text-ink-2 dark:border-white/10 dark:bg-white/5 dark:text-white/80"
              >
                {currencyChoices[0] ?? "—"} · {currencyName(currencyChoices[0] ?? "")}
              </span>
            )}
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
