"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { IconPin, IconWindmill } from "@tabler/icons-react";
import useDraggableWindow from "@/lib/useDraggableWindow";
import Pagination from "@/components/Pagination";
import SafeAssetImage from "@/components/SafeAssetImage";
import StockDetailView from "@/components/StockDetailView";
import StockTextLink from "@/components/StockTextLink";
import { normalizeCode, parseSymbolToken, splitTradingText, type HoldingHint } from "@/lib/tradingSquareText";
import type { StockRecord } from "@/lib/types";

type AuthorId = "trump" | "duan";
type DuanCategory = "hot" | "original" | "longform";
type Quote = { name: string; text: string; url?: string };
type Post = { id: string; author: AuthorId; date: string; text: string; textZh?: string; originalUrl: string; categories?: DuanCategory[]; quote?: Quote };

const PEOPLE = [
  { id: "trump" as const, name: "特朗普", handle: "@realDonaldTrump", platform: "Truth Social", avatar: "/uploads/celebs/trump-custom-1786043526485-1e34c87e.png" },
  { id: "duan" as const, name: "段永平", handle: "@slowisquick", platform: "雪球", avatar: "/uploads/celebs/duan-custom-1785959747574-b3c57b2d.png" }
];
const CATEGORY_OPTIONS: Array<{ id: "all" | DuanCategory; label: string }> = [
  { id: "all", label: "全部" },
  { id: "hot", label: "热门" },
  { id: "original", label: "原发" },
  { id: "longform", label: "长文" }
];
const PAGE_SIZE = 10;
const FEED_CACHE_KEY = "fire:trading-square-feed";
const SEEN_CACHE_KEY = "fire:trading-square-seen";
type AuthorTimes = Record<AuthorId, string | null>;
type AuthorFlags = Record<AuthorId, boolean>;
type FeedPayload = { posts?: Post[]; updatedAt?: string | null; updatedByAuthor?: AuthorTimes; refreshing?: boolean; refreshingByAuthor?: AuthorFlags };

function emptyTimes(): AuthorTimes { return { trump: null, duan: null }; }
function emptyFlags(): AuthorFlags { return { trump: false, duan: false }; }

function latestPostTime(posts: Post[], author: AuthorId): string | null {
  return posts.find((post) => post.author === author)?.date ?? null;
}

function readLocalFeed(): { posts: Post[]; updatedAt: string | null; updatedByAuthor: AuthorTimes } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = JSON.parse(localStorage.getItem(FEED_CACHE_KEY) || "null") as { posts?: Post[]; updatedAt?: string | null; updatedByAuthor?: AuthorTimes } | null;
    if (Array.isArray(raw?.posts) && raw.posts.length) {
      return {
        posts: raw.posts,
        updatedAt: raw.updatedAt ?? null,
        updatedByAuthor: { trump: raw.updatedByAuthor?.trump ?? null, duan: raw.updatedByAuthor?.duan ?? null }
      };
    }
  } catch { /* ignore broken cache */ }
  return null;
}

function writeLocalFeed(posts: Post[], updatedAt: string | null, updatedByAuthor: AuthorTimes) {
  try { localStorage.setItem(FEED_CACHE_KEY, JSON.stringify({ posts, updatedAt, updatedByAuthor })); } catch { /* quota / private mode */ }
}

function readSeen(posts: Post[]): AuthorTimes {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_CACHE_KEY) || "null") as AuthorTimes | null;
    if (raw && typeof raw === "object" && (raw.trump || raw.duan)) {
      return { trump: raw.trump ?? latestPostTime(posts, "trump"), duan: raw.duan ?? latestPostTime(posts, "duan") };
    }
  } catch { /* ignore */ }
  const seeded = { trump: latestPostTime(posts, "trump"), duan: latestPostTime(posts, "duan") };
  writeSeen(seeded);
  return seeded;
}

function writeSeen(seen: AuthorTimes) {
  try { localStorage.setItem(SEEN_CACHE_KEY, JSON.stringify(seen)); } catch { /* quota / private mode */ }
}

function unseenCount(posts: Post[], author: AuthorId, seen: AuthorTimes): number {
  const seenAt = Date.parse(seen[author] || "");
  return posts.filter((post) => {
    if (post.author !== author) return false;
    const time = Date.parse(post.date);
    return Number.isFinite(time) && (!Number.isFinite(seenAt) || time > seenAt);
  }).length;
}

function mergeFeedPosts(previous: Post[], incoming: Post[]): Post[] {
  const prevById = new Map(previous.map((post) => [post.id, post]));
  const newestShown = previous.reduce((max, post) => {
    if (post.author !== "trump") return max;
    const time = Date.parse(post.date);
    return Number.isFinite(time) && time > max ? time : max;
  }, 0);
  return incoming.flatMap((post) => {
    const old = prevById.get(post.id);
    const next = !post.textZh && old?.textZh ? { ...post, textZh: old.textZh } : post;
    if (next.author === "trump" && !next.textZh && !old) {
      const time = Date.parse(next.date);
      if (Number.isFinite(time) && time > newestShown) return [];
    }
    return [next];
  });
}
const BADGE_SHAPE = "M8.82.521a1.596 1.596 0 012.36 0l.362.398c.42.46 1.07.635 1.664.445l.512-.163a1.596 1.596 0 012.043 1.18l.115.525a1.596 1.596 0 001.218 1.218l.525.115a1.596 1.596 0 011.18 2.043l-.163.513a1.596 1.596 0 00.446 1.663l.397.362a1.596 1.596 0 010 2.36l-.397.362c-.461.42-.635 1.07-.446 1.664l.163.512a1.59 1.59 0 01-1.18 2.043l-.525.115a1.596 1.596 0 00-1.218 1.218l-.115.525a1.596 1.596 0 01-2.043 1.18l-.512-.163a1.596 1.596 0 00-1.664.445l-.362.398a1.596 1.596 0 01-2.36 0l-.362-.398a1.596 1.596 0 00-1.663-.445l-.513.163a1.596 1.596 0 01-2.043-1.18l-.115-.525a1.59 1.59 0 00-1.218-1.218l-.525-.115a1.596 1.596 0 01-1.18-2.043l.164-.512a1.596 1.596 0 00-.446-1.664L.52 11.18a1.596 1.596 0 010-2.36l.398-.362c.46-.42.635-1.07.446-1.663L1.2 6.282a1.596 1.596 0 011.18-2.043l.525-.115a1.596 1.596 0 001.218-1.218l.115-.525A1.596 1.596 0 016.282 1.2l.513.163c.594.19 1.244.015 1.663-.445L8.821.52z";

function PlatformBadge({ platform }: { platform: AuthorId }) {
  const color = platform === "trump" ? "#f43f6b" : "#1d9bf0";
  return (
    <svg aria-label={platform === "trump" ? "Truth Social 已认证" : "雪球认证"} viewBox="0 0 20 20" className="ml-1 inline-block h-4 w-4 shrink-0 align-text-bottom">
      <path d={BADGE_SHAPE} fill={color} />
      <path d="M6.66 7.464 5.012 9.111l3.85 3.85 5.483-5.481-1.966-1.966-3.835 3.836L6.66 7.464z" fill="#fff" />
      {platform === "trump" && <path opacity=".5" d="m11.25 15.55-1.646-1.848 1.646-1.646 1.887 1.887-1.887 1.606z" fill="#fff" />}
    </svg>
  );
}

function ActivityIcon() {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-edge-strong text-ink-2 dark:border-white/15">
      <IconWindmill size={21} stroke={1.8} />
    </span>
  );
}

function Avatar({ src, name, large = false }: { src: string; name: string; large?: boolean }) {
  const box = large ? "h-10 w-10" : "h-9 w-9";
  return (
    <SafeAssetImage
      src={src}
      alt=""
      className={`${box} shrink-0 rounded-full object-cover`}
      fallback={<span className={`grid ${box} shrink-0 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300`}>{name.slice(0, 1)}</span>}
    />
  );
}

function formatPostTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatUpdatedAt(value: string | null, withSuffix = true) {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  const suffix = withSuffix ? "更新" : "";
  if (minutes < 1) return `刚刚${suffix}`;
  if (minutes < 60) return `${minutes} 分钟前${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前${suffix}`;
  return `${new Date(time).toLocaleDateString("zh-CN")}${suffix ? ` ${suffix}` : ""}`;
}

function readQuery(): { selected: "all" | AuthorId; duanCategory: "all" | DuanCategory; page: number; symbol: string } {
  if (typeof window === "undefined") return { selected: "all", duanCategory: "all", page: 1, symbol: "" };
  const params = new URLSearchParams(window.location.search);
  const person = params.get("person");
  const cat = params.get("cat");
  const page = Number(params.get("page") || "1");
  return {
    selected: person === "trump" || person === "duan" ? person : "all",
    duanCategory: cat === "hot" || cat === "original" || cat === "longform" ? cat : "all",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    symbol: params.get("symbol") || ""
  };
}

function writeQuery(selected: "all" | AuthorId, duanCategory: "all" | DuanCategory, page: number, symbol = "") {
  const url = new URL(window.location.href);
  if (selected === "all") url.searchParams.delete("person");
  else url.searchParams.set("person", selected);
  if (selected === "duan" && duanCategory !== "all") url.searchParams.set("cat", duanCategory);
  else url.searchParams.delete("cat");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  if (symbol) url.searchParams.set("symbol", symbol);
  else url.searchParams.delete("symbol");
  const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "");
  window.history.replaceState(null, "", next);
}

function parseSymbol(raw: string): { market: string; code: string; name: string } | null {
  const match = /^([A-Z]{2,5})[:.](.+)$/i.exec(raw.trim());
  if (!match) return null;
  const parsed = parseSymbolToken(match[2]);
  const market = parsed?.market || match[1].toUpperCase();
  const code = parsed?.code || match[2].toUpperCase();
  return { market, code, name: code };
}

const LINK_CLASS = "inline bg-transparent p-0 font-semibold text-brand-deep hover:underline";

function PostBody({ text, holdings, onStock, className = "mt-2 whitespace-pre-line break-words text-[15px] leading-7 text-ink dark:text-slate-200" }: { text: string; holdings: HoldingHint[]; onStock: (item: HoldingHint) => void; className?: string }) {
  const parts = useMemo(() => splitTradingText(text, holdings), [holdings, text]);
  return (
    <div className={className}>
      {parts.map((part, index) => {
        if (part.type === "url") {
          return <a key={`${part.value}-${index}`} href={part.value} target="_blank" rel="noreferrer" className={`${LINK_CLASS} break-all`}>{part.value}</a>;
        }
        if (part.type === "stock") {
          return (
            <StockTextLink
              key={`${part.market}-${part.code}-${index}`}
              value={part.value}
              market={part.market}
              code={part.code}
              name={part.name}
              onClick={() => onStock({ market: part.market, code: part.code, name: part.name })}
            />
          );
        }
        return <span key={index}>{part.value}</span>;
      })}
    </div>
  );
}

export default function TradingSquareView({ avatars, records = [] }: { avatars?: Record<string, string>; records?: StockRecord[] }) {
  const [posts, setPosts] = useState<Post[]>(() => readLocalFeed()?.posts ?? []);
  const [loading, setLoading] = useState(() => !readLocalFeed());
  const [refreshingByAuthor, setRefreshingByAuthor] = useState<AuthorFlags>(emptyFlags);
  const [updatedByAuthor, setUpdatedByAuthor] = useState<AuthorTimes>(() => readLocalFeed()?.updatedByAuthor ?? emptyTimes());
  const [seen, setSeen] = useState<AuthorTimes>(() => readSeen(readLocalFeed()?.posts ?? []));
  const [selected, setSelected] = useState<"all" | AuthorId>(() => readQuery().selected);
  const [duanCategory, setDuanCategory] = useState<"all" | DuanCategory>(() => readQuery().duanCategory);
  const [page, setPage] = useState(() => readQuery().page);
  const [detail, setDetail] = useState<{ market: string; code: string; name: string } | null>(() => parseSymbol(readQuery().symbol));
  const [original, setOriginal] = useState<Record<string, boolean>>({});
  const [fixed, setFixed] = useState(false);
  const fixedInitialized = useRef(false);
  const pollLeft = useRef(0);
  const { pos, dragging, onTitleMouseDown } = useDraggableWindow("fire:trading-square-window-pos", fixed);
  const people = useMemo(
    () => PEOPLE.map((person) => ({ ...person, avatar: avatars?.[person.id] || person.avatar })),
    [avatars]
  );
  const holdings = useMemo<HoldingHint[]>(() => {
    const seen = new Set<string>();
    const list: HoldingHint[] = [];
    records.forEach((record) => {
      const market = record.market.toUpperCase();
      const code = normalizeCode(record.code, market);
      const key = `${market}:${code}`;
      if (!code || seen.has(key)) return;
      seen.add(key);
      list.push({ market, code, name: record.name || code });
    });
    return list;
  }, [records]);
  const openStock = (item: HoldingHint) => setDetail({ market: item.market, code: item.code, name: item.name });

  useEffect(() => {
    if (fixedInitialized.current) return;
    try { setFixed(localStorage.getItem("fire:trading-square-window-fixed") === "1"); } catch { /* ignore */ }
    fixedInitialized.current = true;
  }, []);

  const toggleFixed = () => setFixed((value) => {
    const next = !value;
    try { localStorage.setItem("fire:trading-square-window-fixed", next ? "1" : "0"); } catch { /* keep this-session state */ }
    return next;
  });

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/trading-square/feed", { cache: "no-store", signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as FeedPayload;
        if (!active) return;
        const nextUpdated = { trump: data.updatedByAuthor?.trump ?? null, duan: data.updatedByAuthor?.duan ?? null };
        setPosts((current) => {
          const nextPosts = mergeFeedPosts(current, data.posts ?? []);
          writeLocalFeed(nextPosts, data.updatedAt ?? null, nextUpdated);
          return nextPosts;
        });
        setUpdatedByAuthor(nextUpdated);
        setRefreshingByAuthor({ trump: Boolean(data.refreshingByAuthor?.trump), duan: Boolean(data.refreshingByAuthor?.duan) });
        if (data.refreshingByAuthor?.trump || data.refreshingByAuthor?.duan || data.refreshing) pollLeft.current = Math.max(pollLeft.current, 12);
      } catch {
        /* keep existing cache on screen */
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const refreshing = refreshingByAuthor.trump || refreshingByAuthor.duan;

  useEffect(() => {
    if (!refreshing || pollLeft.current <= 0) return;
    const timer = window.setTimeout(() => {
      pollLeft.current -= 1;
      void fetch("/api/trading-square/feed", { cache: "no-store", signal: AbortSignal.timeout(4000) })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: FeedPayload | null) => {
          if (!data) return;
          const nextUpdated = { trump: data.updatedByAuthor?.trump ?? null, duan: data.updatedByAuthor?.duan ?? null };
          setPosts((current) => {
            const nextPosts = mergeFeedPosts(current, data.posts ?? []);
            writeLocalFeed(nextPosts, data.updatedAt ?? null, nextUpdated);
            return nextPosts;
          });
          setUpdatedByAuthor(nextUpdated);
          setRefreshingByAuthor({
            trump: Boolean(data.refreshingByAuthor?.trump) && pollLeft.current > 0,
            duan: Boolean(data.refreshingByAuthor?.duan) && pollLeft.current > 0
          });
        })
        .catch(() => setRefreshingByAuthor(emptyFlags()));
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [refreshing, updatedByAuthor]);

  const visible = useMemo(() => posts.filter((post) => {
    if (selected !== "all" && post.author !== selected) return false;
    if (selected === "duan" && duanCategory !== "all") return post.categories?.includes(duanCategory) === true;
    return true;
  }), [duanCategory, posts, selected]);

  const orderedPeople = useMemo(() => [...people].sort((a, b) => {
    const latest = (author: AuthorId) => posts.find((post) => post.author === author)?.date;
    return Date.parse(latest(b.id) || "1970-01-01") - Date.parse(latest(a.id) || "1970-01-01");
  }), [people, posts]);

  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);

  useEffect(() => {
    if (selected !== "duan" && duanCategory !== "all") setDuanCategory("all");
  }, [duanCategory, selected]);

  useEffect(() => {
    writeQuery(selected, duanCategory, safePage, detail ? `${detail.market}:${detail.code}` : "");
  }, [detail, duanCategory, safePage, selected]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const markSeen = (author: AuthorId) => {
    const latest = latestPostTime(posts, author);
    if (!latest || seen[author] === latest) return;
    const next = { ...seen, [author]: latest };
    setSeen(next);
    writeSeen(next);
  };

  const changePerson = (next: "all" | AuthorId) => {
    if (next !== "all") markSeen(next);
    setSelected(next);
    setPage(1);
  };

  useEffect(() => {
    if (selected === "trump" || selected === "duan") markSeen(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, selected]);

  const categoryCount = (category: DuanCategory) => posts.filter((post) => post.author === "duan" && post.categories?.includes(category)).length;
  const windowStyle = { "--trading-x": `${pos.x}px`, "--trading-y": `${pos.y}px` } as CSSProperties;
  const freshness = selected === "all"
    ? PEOPLE.map((person) => {
      if (refreshingByAuthor[person.id]) return `${person.name}正在检查`;
      const label = formatUpdatedAt(updatedByAuthor[person.id], false);
      return label ? `${person.name} ${label}` : "";
    }).filter(Boolean).join(" · ")
    : refreshingByAuthor[selected] ? "正在检查更新" : formatUpdatedAt(updatedByAuthor[selected]);
  const newCounts = {
    trump: unseenCount(posts, "trump", seen),
    duan: unseenCount(posts, "duan", seen)
  };
  const followed = detail ? records.some((record) => {
    const market = record.market.toUpperCase();
    return market === detail.market && normalizeCode(record.code, market) === detail.code;
  }) : false;

  if (detail) {
    return (
      <main style={windowStyle} className={`mx-auto w-full max-w-[800px] overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#10151d] md:[transform:translate(var(--trading-x),var(--trading-y))] ${dragging ? "select-none" : ""}`}>
        <div style={{ animation: "fade-in .25s ease" }}>
          <StockDetailView market={detail.market} code={detail.code} name={detail.name} onBack={() => setDetail(null)} followed={followed} />
        </div>
      </main>
    );
  }

  return (
    <main style={windowStyle} className={`mx-auto grid w-full max-w-[800px] overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#10151d] md:grid-cols-[200px_minmax(0,1fr)] md:[transform:translate(var(--trading-x),var(--trading-y))] ${dragging ? "select-none" : ""}`}>
      <aside className="flex gap-2 overflow-x-auto border-b border-edge p-3 dark:border-white/10 md:block md:overflow-visible md:border-b-0 md:border-r">
        <button type="button" aria-pressed={selected === "all"} onClick={() => changePerson("all")} className={`flex min-w-[142px] items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-bg-gray active:scale-[.98] dark:hover:bg-white/[.035] md:mb-1 md:w-full md:min-w-0 ${selected === "all" ? "bg-brand-light dark:bg-[#1a202a]" : ""}`}>
          <ActivityIcon />
          <div>
            <strong className="block text-sm text-ink dark:text-white">全部动态</strong>
            <span className="text-xs tabular-nums text-muted">{posts.length || "—"} 条</span>
          </div>
        </button>
        {orderedPeople.map((person) => {
          const fresh = newCounts[person.id];
          return (
            <button key={person.id} type="button" aria-pressed={selected === person.id} onClick={() => changePerson(person.id)} className={`flex min-w-[168px] items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-bg-gray active:scale-[.98] dark:hover:bg-white/[.035] md:mb-1 md:w-full md:min-w-0 ${selected === person.id ? "bg-brand-light dark:bg-[#1a202a]" : ""}`}>
              <Avatar src={person.avatar} name={person.name} />
              <div className="min-w-0 flex-1">
                <strong className="flex items-center truncate text-sm text-ink dark:text-white">{person.name}<PlatformBadge platform={person.id} /></strong>
                <span className="block truncate text-xs text-muted">{person.platform}</span>
              </div>
              {fresh > 0 && (
                <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-up px-1.5 text-[10px] font-bold tabular-nums leading-none text-white" title={`自上次查看后新增 ${fresh} 条`}>
                  {fresh > 99 ? "99+" : fresh}
                </span>
              )}
            </button>
          );
        })}
      </aside>
      <section className="min-w-0">
        <header onMouseDown={onTitleMouseDown} title={fixed ? undefined : "按住拖动窗口"} className={`border-b border-edge px-4 py-4 dark:border-white/10 sm:px-5 ${fixed ? "" : "md:cursor-grab md:active:cursor-grabbing"}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-ink dark:text-white">{selected === "all" ? "全部动态" : people.find((person) => person.id === selected)?.name}</h1>
              {freshness ? <p className="mt-0.5 break-words text-[11px] leading-4 text-faint">{freshness}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-muted">{visible.length} 条</span>
              <button type="button" onClick={toggleFixed} title={fixed ? "已固定窗口（点击解锁拖动）" : "固定窗口（锁定当前位置）"} aria-label={fixed ? "取消固定交易广场" : "固定交易广场"} aria-pressed={fixed} className={`grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-bg-gray hover:text-ink active:scale-[.96] dark:hover:bg-white/10 dark:hover:text-white ${fixed ? "opacity-100" : "opacity-60"}`}>
                <IconPin size={16} stroke={1.8} fill={fixed ? "currentColor" : "none"} />
              </button>
            </div>
          </div>
          {selected === "duan" && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5">
              {CATEGORY_OPTIONS.map((option) => {
                const count = option.id === "all" ? posts.filter((post) => post.author === "duan").length : categoryCount(option.id);
                return (
                  <button key={option.id} type="button" aria-pressed={duanCategory === option.id} onClick={() => { setDuanCategory(option.id); setPage(1); }} className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition active:scale-[.97] ${duanCategory === option.id ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/10 dark:text-slate-300"}`}>
                    {option.label}
                    <span className={`ml-1.5 tabular-nums ${duanCategory === option.id ? "opacity-70" : "text-slate-400 dark:text-slate-500"}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </header>
        <div className="divide-y divide-edge dark:divide-white/10">
          {loading ? (
            <div className="space-y-5 px-5 py-6" aria-label="正在加载动态">
              {[0, 1, 2].map((item) => (
                <div key={item} className="flex animate-pulse gap-3">
                  <div className="h-10 w-10 shrink-0 rounded-full bg-slate-200 dark:bg-white/10" />
                  <div className="flex-1 space-y-3">
                    <div className="h-3 w-36 rounded bg-slate-200 dark:bg-white/10" />
                    <div className="h-3 w-full rounded bg-slate-100 dark:bg-white/5" />
                    <div className="h-3 w-3/4 rounded bg-slate-100 dark:bg-white/5" />
                  </div>
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-sm font-medium text-ink dark:text-white">{refreshing ? "正在拉取近期动态" : "这个分类暂时没有动态"}</p>
              <p className="mt-1 text-xs text-muted">{refreshing ? "页面会自动显示新内容，无需手动刷新" : "切换其他分类查看近期内容"}</p>
            </div>
          ) : visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE).map((post) => {
            const showOriginal = original[post.id] === true;
            const author = people.find((person) => person.id === post.author) ?? people[0];
            return (
              <article key={`${post.author}-${post.id}`} className="px-4 py-5 sm:px-5">
                <div className="flex gap-3">
                  <Avatar src={author.avatar} name={author.name} large />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <strong className="text-ink dark:text-white">{author.name}</strong>
                      <PlatformBadge platform={author.id} />
                      <span className="text-muted">{author.handle}</span>
                      <span className="text-faint">·</span>
                      <time className="text-muted" dateTime={post.date}>{formatPostTime(post.date)}</time>
                    </div>
                    <PostBody text={showOriginal ? post.text : (post.textZh ?? post.text)} holdings={holdings} onStock={openStock} />
                    {post.quote && (
                      <div className="mt-3 rounded-xl border border-edge bg-bg-gray/60 px-3 py-2.5 dark:border-white/10 dark:bg-white/[.04]">
                        <p className="text-xs font-semibold text-muted">{post.quote.name}</p>
                        <PostBody
                          text={post.quote.text}
                          holdings={holdings}
                          onStock={openStock}
                          className="mt-1 whitespace-pre-line break-words text-[13px] leading-6 text-ink-2 dark:text-slate-300"
                        />
                        {post.quote.url && (
                          <a href={post.quote.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[11px] font-semibold text-brand-deep">查看原动态 ↗</a>
                        )}
                      </div>
                    )}
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
                      <a href={post.originalUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-deep">查看原文 ↗</a>
                      {post.textZh && (
                        <button type="button" onClick={() => setOriginal((value) => ({ ...value, [post.id]: !showOriginal }))} className="font-semibold">
                          {showOriginal ? "中文" : "原文"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
        {visible.length > PAGE_SIZE && (
          <nav className="border-t border-edge px-4 py-3 dark:border-white/10">
            <Pagination page={safePage} total={pages} onChange={setPage} />
          </nav>
        )}
      </section>
    </main>
  );
}
