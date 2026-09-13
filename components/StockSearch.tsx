"use client";

import { useEffect, useRef, useState } from "react";
import { marketMeta, type SearchMatch } from "@/lib/types";
import { fmtNum, fmtNumMarket, fmtPct } from "@/lib/format";
import RainbowTextInput from "@/components/RainbowTextInput";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import SafeAssetImage from "@/components/SafeAssetImage";
import EtfDoubleBadge from "@/components/EtfDoubleBadge";
import { ensureStockIcons, useAssetIcons } from "@/lib/useAssetIcons";
import { pickStockIcon } from "@/lib/stockIconKey";
import { RELATED_ETF_MAIN_STOCK, US_RELATED_ETFS } from "@/lib/relatedEtfs";

const SEARCH_CACHE_TTL = 60_000;
const searchCache = new Map<string, { at: number; results: SearchMatch[] }>();

function relatedEtfMeta(match: SearchMatch): { main: string } | null {
  if (match.market !== "US") return null;
  const code = match.code.trim().toUpperCase().replace(/\.(?:AM|N|OQ|PS|K)$/i, "");
  const main = RELATED_ETF_MAIN_STOCK[code];
  if (!main) return null;
  const relation = US_RELATED_ETFS[main]?.find((item) => item.code === code);
  if (!relation) return null;
  return { main };
}

interface Props {
  onSelect: (match: SearchMatch) => void;
  placeholder?: string;
  large?: boolean;
  autoFocus?: boolean;
  /** 判断该股票是否已关注（在自选股中）；提供 onToggleFollow 时显示关注按钮 */
  followed?: (match: SearchMatch) => boolean;
  /** 关注 / 取消关注回调（点击爱心触发，返回是否成功） */
  onToggleFollow?: (match: SearchMatch) => Promise<boolean>;
  /** 搜索框右侧相机图标（截图识别导入入口），传入后显示 */
  onCameraClick?: () => void;
  /** 相机入口的上下文提示 */
  cameraTitle?: string;
  /** 输入字符逐位彩虹显示（仅指定的股票添加入口启用） */
  rainbow?: boolean;
}

export default function StockSearch({ onSelect, placeholder = "输入股票名称或代码搜索", large = false, autoFocus = false, followed, onToggleFollow, onCameraClick, cameraTitle = "上传持仓 / 行情截图，自动识别并同步", rainbow = false }: Props) {
  const { stockIcons, assetIcons } = useAssetIcons(["stock", "crypto"]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const cacheKey = query.toLocaleLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL) {
      setResults(cached.results);
      setOpen(true);
      setHighlight(-1);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!res.ok) {
          setResults([]);
          return;
        }
        const data = await res.json();
        const next = Array.isArray(data.results) ? data.results as SearchMatch[] : [];
        searchCache.delete(cacheKey);
        searchCache.set(cacheKey, { at: Date.now(), results: next });
        while (searchCache.size > 100) {
          const oldest = searchCache.keys().next().value;
          if (!oldest) break;
          searchCache.delete(oldest);
        }
        setResults(next);
        setOpen(true);
        setHighlight(-1);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 140);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  useEffect(() => {
    const pairs = results.flatMap((match) => {
      if (match.type === "crypto" || match.market === "ASSET") return [];
      const related = relatedEtfMeta(match);
      return [{ market: match.market, code: match.code }, ...(related ? [{ market: "US", code: related.main }] : [])];
    });
    if (pairs.length > 0) void ensureStockIcons(pairs);
  }, [results]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function choose(m: SearchMatch) {
    onSelect(m);
    setQ("");
    setResults([]);
    setOpen(false);
  }

  async function toggleFollow(m: SearchMatch) {
    if (!onToggleFollow || busy.has(m.symbol)) return;
    setBusy((s) => new Set(s).add(m.symbol));
    try {
      await onToggleFollow(m);
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(m.symbol);
        return n;
      });
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      choose(results[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <div className={`flex items-center gap-2.5 rounded-full border border-edge-strong bg-white px-4 transition-colors focus-within:border-edge-strong focus-within:shadow-[0_0_0_3px_rgba(107,114,128,.16)] ${large ? "h-[52px]" : "h-[42px]"}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 flex-none text-faint">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        {rainbow ? (
          <RainbowTextInput value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} onFocus={() => results.length > 0 && setOpen(true)} placeholder={placeholder} autoFocus={autoFocus} className="min-w-0 flex-1 text-sm" />
        ) : (
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} onFocus={() => results.length > 0 && setOpen(true)} placeholder={placeholder} autoFocus={autoFocus} className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none" />
        )}
        {loading && (
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin text-faint">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        {onCameraClick && (
          <button
            type="button"
            onClick={onCameraClick}
            title={cameraTitle}
            aria-label={cameraTitle}
            className="flex-none rounded-full p-1.5 text-faint transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3.2" /></svg>
          </button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-[14px] border border-edge bg-white shadow-pop">
          {results.length === 0 ? (
            <div className="px-4 py-4 text-sm text-faint">未找到相关股票或加密货币，可直接手动填写</div>
          ) : (
            results.map((m, i) => {
              const related = relatedEtfMeta(m);
              const icon = m.type === "crypto" || m.market === "ASSET"
                ? assetIcons[m.code.toUpperCase()]
                : pickStockIcon(stockIcons, m.market, related?.main || m.code);
              return (
              <div
                key={m.symbol}
                onMouseEnter={() => setHighlight(i)}
                className={`flex w-full items-center gap-2 px-4 py-3 text-left text-sm transition-colors ${i === highlight ? "bg-brand-light" : "hover:bg-brand-hover"}`}
              >
                <button
                  type="button"
                  onClick={() => choose(m)}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                >
                  <span className="relative flex h-9 w-9 flex-none items-center justify-center">
                    <SafeAssetImage
                      src={icon}
                      alt=""
                      className="h-9 w-9 rounded-full object-cover"
                      fallback={<span className="grid h-9 w-9 place-items-center rounded-full bg-bg-gray text-xs font-bold text-muted dark:bg-white/10">{m.name.slice(0, 1)}</span>}
                    />
                    {related && <EtfDoubleBadge market={m.market} code={m.code} name={m.name} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block max-w-[min(46vw,260px)] truncate font-semibold">{m.name}</span>
                    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                      <MarketCodeBadge market={m.type === "crypto" ? "CRYPTO" : m.market} code={m.code} />
                      <span className="min-w-0 truncate">{m.code}</span>
                    </span>
                  </span>
                  <span className="flex flex-col items-end">
                    {m.price !== null && <span className="font-semibold tabular-nums">{fmtNumMarket(m.price, m.market)}</span>}
                    {m.changePct !== null && (
                      <span className={`text-xs font-semibold tabular-nums ${m.changePct >= 0 ? "text-up" : "text-down"}`}>
                        {m.changePct >= 0 ? "+" : ""}{fmtPct(m.changePct / 100)}
                      </span>
                    )}
                  </span>
                </button>
                {onToggleFollow && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFollow(m);
                    }}
                    disabled={busy.has(m.symbol)}
                    aria-label={followed?.(m) ? "取消关注" : "关注"}
                    title={followed?.(m) ? "取消关注" : "关注"}
                    className={`flex h-8 w-8 flex-none items-center justify-center rounded-full transition-all duration-200 active:scale-[.94] ${
                      followed?.(m) ? "text-[#ef4444]" : "text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
                    }`}
                  >
                    <svg
                      viewBox="49.42 40.42 1086.9 948.55"
                      fill="currentColor"
                      stroke="none"
                      className={`h-[18px] w-[18px] ${followed?.(m) ? "heart-pop" : "opacity-75"}`}
                    >
                      <path d="M815.157895 40.421053c175.427368 0 316.200421 140.773053 321.158737 313.667368v56.858947H1037.473684v-49.421473a221.399579 221.399579 0 0 0-222.315789-222.31579c-71.626105 0-135.814737 32.121263-177.852632 88.926316l-4.904421 4.958316L592.842105 289.899789l-39.504842-56.805052a221.453474 221.453474 0 0 0-182.810947-93.884632A221.399579 221.399579 0 0 0 148.210526 361.525895c0 200.111158 229.753263 442.152421 437.248 521.216l7.383579 2.479158h2.479158c19.779368-7.383579 39.558737-17.246316 61.763369-29.642106l9.862736-4.958315 42.037895-24.68379 49.367579 86.447158-41.984 24.737684c-34.600421 19.725474-66.667789 34.546526-96.309895 44.409263l-9.916631 4.958316-17.246316 2.479158-14.874947-4.958316c-103.747368-34.546526-212.399158-103.747368-303.804632-192.673684l-14.821053-14.821053c-121.047579-118.568421-209.973895-269.204211-209.973894-414.989473C49.421474 183.673263 192.673684 40.421053 370.526316 40.421053c81.542737 0 158.127158 29.642105 217.411368 83.968L592.842105 129.347368l4.958316-4.958315A318.679579 318.679579 0 0 1 805.295158 40.421053h9.862737zM988.106105 485.052632v148.210526h148.210527v98.789053h-148.210527v148.210526H889.263158v-148.210526h-148.210526V633.263158h148.210526V485.052632h98.842947z" />
                    </svg>
                  </button>
                )}
              </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
