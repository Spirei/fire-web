"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import SafeAssetImage from "@/components/SafeAssetImage";
import { fmtCap, fmtNumMarket, fmtPct, fmtPrice, fmtQuoteTime } from "@/lib/format";
import { useMarketBadge, useMarketBadgeVisible } from "@/lib/useMarketBadge";
import { marketMeta, type Quote } from "@/lib/types";
import { useAssetIcons } from "@/lib/useAssetIcons";

const QUOTE_TTL = 30_000;
const ENTER_MS = 160;
const LEAVE_MS = 140;
const CARD_WIDTH = 268;

const quoteCache = new Map<string, { quote: Quote | null; at: number }>();
const quoteInflight = new Map<string, Promise<Quote | null>>();

function quoteId(market: string, code: string) {
  return `${market.toUpperCase()}:${code.toUpperCase()}`;
}

function readCachedQuote(market: string, code: string): Quote | null | undefined {
  const hit = quoteCache.get(quoteId(market, code));
  if (!hit) return undefined;
  if (Date.now() - hit.at > QUOTE_TTL) return undefined;
  return hit.quote;
}

function loadQuote(market: string, code: string): Promise<Quote | null> {
  const id = quoteId(market, code);
  const cached = readCachedQuote(market, code);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = quoteInflight.get(id);
  if (pending) return pending;
  const request = fetch("/api/v1/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id, market, code }] }),
    cache: "no-store"
  })
    .then((response) => response.json().catch(() => null))
    .then((payload) => {
      const quotes = payload?.data?.quotes ?? {};
      const quote = (quotes[id] ?? null) as Quote | null;
      quoteCache.set(id, { quote, at: Date.now() });
      return quote;
    })
    .catch(() => {
      quoteCache.set(id, { quote: null, at: Date.now() });
      return null;
    })
    .finally(() => quoteInflight.delete(id));
  quoteInflight.set(id, request);
  return request;
}

function sessionLabel(session?: Quote["session"]) {
  if (session === "PRE") return "盘前";
  if (session === "AFTER") return "盘后";
  if (session === "OVERNIGHT") return "夜盘";
  return "";
}

function StockQuoteCard({
  market,
  code,
  name,
  quote,
  onOpen
}: {
  market: string;
  code: string;
  name: string;
  quote: Quote | null | undefined;
  onOpen: () => void;
}) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const icon = stockIcons[quoteId(market, code)];
  const badge = useMarketBadge(market, code);
  const badgeVisible = useMarketBadgeVisible();
  const currency = marketMeta(market).currency;
  const fromQuote = quote?.name && quote.name.toUpperCase() !== code.toUpperCase() ? quote.name : "";
  const fromTag = name && name.toUpperCase() !== code.toUpperCase() ? name : "";
  const displayName = fromQuote || fromTag || name || quote?.name || code;
  const up = (quote?.changePct ?? 0) >= 0;
  const tone = quote ? (up ? "text-up" : "text-down") : "text-faint";
  const session = sessionLabel(quote?.session);

  return (
    <div
      role="tooltip"
      className="overflow-hidden rounded-xl border border-edge bg-white shadow-pop dark:border-white/10 dark:bg-[#16181d]"
    >
      <button type="button" onClick={onOpen} className="block w-full px-3.5 py-3 text-left">
        <div className="flex items-start gap-2.5">
          {icon ? (
            <SafeAssetImage
              src={icon}
              alt=""
              className="h-8 w-8 shrink-0 rounded-full object-cover"
              fallback={<span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bg-gray text-xs font-bold text-muted dark:bg-white/10">{displayName.slice(0, 1)}</span>}
            />
          ) : (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-bg-gray text-xs font-bold text-muted dark:bg-white/10">{displayName.slice(0, 1)}</span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <strong className="min-w-0 truncate text-[13px] text-ink dark:text-white">{displayName}</strong>
              {badgeVisible && <span className="inline-flex h-[16px] shrink-0 items-center rounded px-1 text-[9px] font-bold leading-none" style={{ background: badge.bg, color: badge.fg }}>{badge.label}</span>}
            </div>
            <p className="mt-0.5 text-[11px] tabular-nums text-muted">{code}{session ? ` · ${session}` : ""}</p>
          </div>
        </div>
        {quote === undefined ? (
          <p className="mt-3 text-[12px] text-faint">正在获取行情…</p>
        ) : quote == null ? (
          <p className="mt-3 text-[12px] text-faint">暂无实时行情</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={`text-[22px] font-bold leading-none tabular-nums ${tone}`}>{fmtPrice(quote.price, currency, market)}</span>
              <span className={`text-[12px] font-semibold tabular-nums ${tone}`}>
                {up ? "+" : ""}{fmtPct(quote.changePct / 100)}
                <span className="ml-1.5">{up ? "+" : ""}{fmtNumMarket(quote.change, market)}</span>
              </span>
            </div>
            <p className="mt-2 text-[11px] tabular-nums text-muted">
              {quote.prevClose != null && Number.isFinite(quote.prevClose) ? `昨收 ${fmtPrice(quote.prevClose, currency, market)}` : null}
              {quote.prevClose != null && quote.marketCap ? " · " : null}
              {quote.marketCap ? `市值 ${fmtCap(quote.marketCap)}` : null}
            </p>
            {quote.time ? <p className="mt-1 text-[10px] text-faint">{fmtQuoteTime(quote.time)}</p> : null}
          </>
        )}
        <p className="mt-2.5 text-[10px] font-semibold text-brand-deep">点击查看详情</p>
      </button>
    </div>
  );
}

export default function StockTextLink({
  value,
  market,
  code,
  name,
  onClick
}: {
  value: string;
  market: string;
  code: string;
  name: string;
  onClick: () => void;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number>(0);
  const leaveTimer = useRef<number>(0);
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<Quote | null | undefined>(() => readCachedQuote(market, code));
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const clearTimers = () => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
  };

  const show = () => {
    clearTimers();
    setOpen(true);
  };

  const hide = () => {
    clearTimers();
    setOpen(false);
  };

  const scheduleShow = (pointerType?: string) => {
    if (pointerType && pointerType !== "mouse") return;
    clearTimers();
    enterTimer.current = window.setTimeout(show, ENTER_MS);
  };

  const scheduleHide = () => {
    clearTimers();
    leaveTimer.current = window.setTimeout(hide, LEAVE_MS);
  };

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    let active = true;
    const cached = readCachedQuote(market, code);
    if (cached !== undefined) setQuote(cached);
    void loadQuote(market, code).then((next) => {
      if (active) setQuote(next);
    });
    return () => {
      active = false;
    };
  }, [code, market]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = cardRef.current?.offsetHeight || 168;
      const left = Math.min(Math.max(12, anchor.left), window.innerWidth - CARD_WIDTH - 12);
      const below = anchor.bottom + 8;
      const top = below + height > window.innerHeight - 12 && anchor.top > height + 8
        ? anchor.top - height - 8
        : below;
      setPos({ left, top: Math.max(8, top) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, quote]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        onClick={onClick}
        onPointerEnter={(event) => scheduleShow(event.pointerType)}
        onPointerLeave={scheduleHide}
        onFocus={() => scheduleShow("mouse")}
        onBlur={scheduleHide}
        className={`inline cursor-pointer whitespace-nowrap bg-transparent p-0 font-semibold text-brand-deep underline decoration-dashed decoration-1 underline-offset-[5px] ${
          quote && Number.isFinite(quote.changePct)
            ? quote.changePct >= 0 ? "decoration-up" : "decoration-down"
            : "decoration-brand-deep"
        }`}
      >
        {value}
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          id={tooltipId}
          ref={cardRef}
          onPointerEnter={() => {
            clearTimers();
            setOpen(true);
          }}
          onPointerLeave={scheduleHide}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: CARD_WIDTH, zIndex: 80, animation: "fade-in .16s ease" }}
        >
          <StockQuoteCard
            market={market}
            code={code}
            name={name}
            quote={quote}
            onOpen={() => {
              hide();
              onClick();
            }}
          />
        </div>,
        document.body
      )}
    </>
  );
}
