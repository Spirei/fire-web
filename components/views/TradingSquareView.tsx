"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { IconChevronLeft, IconMessageCircle, IconMinus, IconPin, IconPlus, IconThumbUp, IconWindmill } from "@tabler/icons-react";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import useDraggableWindow from "@/lib/useDraggableWindow";
import Pagination from "@/components/Pagination";
import SafeAssetImage from "@/components/SafeAssetImage";
import StockDetailView from "@/components/StockDetailView";
import StockTextLink from "@/components/StockTextLink";
import { isLocalPostImageUrl } from "@/lib/tradingSquareImages";
import { TRADING_SQUARE_AUTHOR_LIMIT, takeNewestByAuthor } from "@/lib/tradingSquareLimits";
import { formatRelativeTime } from "@/lib/format";
import { isUnseenPost, unseenBoundaryIndex, unseenCounts } from "@/lib/tradingSquareSeen";
import { hasTranslatableText, normalizeCode, normalizeTradingText, parseSymbolToken, splitTradingText, type HoldingHint } from "@/lib/tradingSquareText";
import type { StockRecord } from "@/lib/types";

type AuthorId = "trump" | "duan";
type DuanCategory = "hot" | "original" | "longform";
type Quote = { name: string; text: string; url?: string; images?: string[]; avatar?: string };
type PostComment = { id: string; name: string; avatar?: string; createdAt: string; text: string; likes?: number; replyTo?: string };
type Post = { id: string; author: AuthorId; date: string; text: string; textZh?: string; originalUrl: string; categories?: DuanCategory[]; quote?: Quote; images?: string[]; replyTo?: string; comments?: PostComment[]; replies?: number };

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
/** 评论不超过这个数就在帖子下面直接展开；再多就点进二级评论页看（主流社交网站的做法） */
const INLINE_COMMENT_LIMIT = 10;
const FEED_CACHE_KEY = "fire:trading-square-feed";
const SEEN_CACHE_KEY = "fire:trading-square-seen";
/** 筛选状态的 cookie 镜像：让服务端首帧就能画出「段永平 + 分类标签行」，刷新不再先消失再出现。 */
const FILTER_COOKIE = "fire_trading_square_filter";
const FEED_FETCH_MS = 12_000;
type AuthorTimes = Record<string, string | null>;
type AuthorFlags = Record<string, boolean>;
type FeedPayload = { posts?: Post[]; updatedAt?: string | null; updatedByAuthor?: AuthorTimes; refreshing?: boolean; refreshingByAuthor?: AuthorFlags };

function emptyTimes(): AuthorTimes { return {}; }
function emptyFlags(): AuthorFlags { return {}; }

function latestPostTime(posts: Post[], author: string): string | null {
  return posts.find((post) => post.author === author)?.date ?? null;
}

function latestTime(times: AuthorTimes): string | null {
  let best = 0;
  let iso: string | null = null;
  Object.values(times).forEach((value) => {
    const time = Date.parse(value || "");
    if (Number.isFinite(time) && time > best) {
      best = time;
      iso = value;
    }
  });
  return iso;
}

function readLocalFeed(): { posts: Post[]; updatedAt: string | null; updatedByAuthor: AuthorTimes } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = JSON.parse(localStorage.getItem(FEED_CACHE_KEY) || "null") as { posts?: Post[]; updatedAt?: string | null; updatedByAuthor?: AuthorTimes } | null;
    if (Array.isArray(raw?.posts) && raw.posts.length) {
      return {
        posts: takeNewestByAuthor(raw.posts, TRADING_SQUARE_AUTHOR_LIMIT),
        updatedAt: raw.updatedAt ?? null,
        updatedByAuthor: raw.updatedByAuthor && typeof raw.updatedByAuthor === "object" ? raw.updatedByAuthor : emptyTimes()
      };
    }
  } catch { /* ignore broken cache */ }
  return null;
}

/**
 * 首屏缓存最多写这么多条/作者（列表本身不限条数，缓存只服务首次绘制）。
 * 取消接口上限后历史会一直涨，缓存层单独收敛，避免 localStorage 写爆。
 */
const FEED_CACHE_PER_AUTHOR = 400;
const FEED_CACHE_MAX_BYTES = 2_500_000;

function writeLocalFeed(posts: Post[], updatedAt: string | null, updatedByAuthor: AuthorTimes) {
  try {
    const payload = JSON.stringify({ posts: takeNewestByAuthor(posts, FEED_CACHE_PER_AUTHOR), updatedAt, updatedByAuthor });
    if (payload.length > FEED_CACHE_MAX_BYTES) {
      console.warn(`[trading-square] 首屏缓存过大（${Math.round(payload.length / 1024)}KB），本次跳过写入；列表展示不受影响`);
      return;
    }
    localStorage.setItem(FEED_CACHE_KEY, payload);
  } catch (error) {
    // 写失败（配额满 / 无痕模式）会让下次刷新先看到加载态，这里留个痕迹便于排查
    console.warn("[trading-square] 本地缓存写入失败，刷新后将先显示加载态", error);
  }
}

function readSeen(posts: Post[]): AuthorTimes {
  const authors = new Set<string>(PEOPLE.map((person) => person.id));
  posts.forEach((post) => authors.add(post.author));
  // 该函数在 useState 初始化时就会被调用（服务端渲染同样执行），
  // 必须显式判断浏览器环境：此前 `if (!localStorage.getItem(...))` 没被 try 包住，
  // 导致 /trading 服务端渲染直接 ReferenceError → 整页 500。
  const storage = typeof window === "undefined" ? null : window.localStorage;
  let stored: AuthorTimes = {};
  if (storage) {
    try {
      const raw = JSON.parse(storage.getItem(SEEN_CACHE_KEY) || "null") as AuthorTimes | null;
      if (raw && typeof raw === "object") stored = raw;
    } catch { /* ignore */ }
  }
  const seeded: AuthorTimes = {};
  authors.forEach((author) => {
    seeded[author] = stored[author] ?? latestPostTime(posts, author);
  });
  if (storage && !storage.getItem(SEEN_CACHE_KEY)) writeSeen(seeded);
  return seeded;
}

function writeSeen(seen: AuthorTimes) {
  try { localStorage.setItem(SEEN_CACHE_KEY, JSON.stringify(seen)); } catch { /* quota / private mode */ }
}


function localUrls(urls?: string[]): string[] {
  return (urls || []).filter((url) => isLocalPostImageUrl(url));
}

function mergeFeedPosts(previous: Post[], incoming: Post[]): Post[] {
  const prevById = new Map(previous.map((post) => [`${post.author}-${post.id}`, post]));
  const newestShown = previous.reduce((max, post) => {
    if (post.author !== "trump") return max;
    const time = Date.parse(post.date);
    return Number.isFinite(time) && time > max ? time : max;
  }, 0);
  const merged = incoming.flatMap((post) => {
    const old = prevById.get(`${post.author}-${post.id}`);
    let next = hasTranslatableText(post.text) && !post.textZh && old?.textZh ? { ...post, textZh: old.textZh } : post;
    if (!hasTranslatableText(next.text) && next.textZh) {
      next = { ...next };
      delete next.textZh;
    }
    const images = localUrls(next.images).length ? localUrls(next.images) : localUrls(old?.images);
    if (images.length) next = { ...next, images };
    else {
      next = { ...next };
      delete next.images;
    }
    if (next.quote) {
      const quoteImages = localUrls(next.quote.images).length ? localUrls(next.quote.images) : localUrls(old?.quote?.images);
      const quote = { ...next.quote };
      if (quoteImages.length) quote.images = quoteImages;
      else delete quote.images;
      next = { ...next, quote };
    }
    if (next.author === "trump" && !next.textZh && !old && hasTranslatableText(next.text)) {
      const time = Date.parse(next.date);
      if (Number.isFinite(time) && time > newestShown) return [];
    }
    return [next];
  });
  // 服务端列表可能比本地短（某位作者这次没抓到、源站分页变短、或新帖还没翻译被上面过滤掉），
  // 这时不能把本地已有的帖子丢掉：否则一刷新就整片消失，而且缩水后的列表会被写回缓存，
  // 等于把本地缓存也一起清空（用户反馈的「刷新把发文弄没」就是这么来的）。
  // 这里保留「本地有、本次没返回」的帖子，顺序与条数交给 takeNewestByAuthor 按作者截取最新 N 条。
  const seen = new Set(merged.map((post) => `${post.author}-${post.id}`));
  const kept = previous.filter((post) => !seen.has(`${post.author}-${post.id}`));
  return kept.length ? [...merged, ...kept] : merged;
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

function Avatar({ src, name, large = false, badge = 0 }: { src: string; name: string; large?: boolean; badge?: number }) {
  const box = large ? "h-10 w-10" : "h-9 w-9";
  return (
    <span className="relative shrink-0">
      <SafeAssetImage
        src={src}
        alt=""
        className={`${box} rounded-full object-cover`}
        fallback={<span className={`grid ${box} place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300`}>{name.slice(0, 1)}</span>}
      />
      {badge > 0 ? (
        <span className="absolute -bottom-px -right-px inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-up px-0.5 text-[8px] font-bold tabular-nums leading-none text-white ring-[1.5px] ring-white dark:ring-[#10151d]">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </span>
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
  // 镜像到 cookie：下次刷新服务端首帧就能画出同一份筛选状态（标签行不再先消失再出现）。
  try {
    document.cookie = `${FILTER_COOKIE}=${encodeURIComponent(url.searchParams.toString())}; path=/; max-age=31536000; SameSite=Lax`;
  } catch { /* cookie 不可用时只影响首帧，不影响筛选本身 */ }
}

function parseSymbol(raw: string): { market: string; code: string; name: string } | null {
  const match = /^([A-Z]{2,5})[:.](.+)$/i.exec(raw.trim());
  if (!match) return null;
  const parsed = parseSymbolToken(match[2]);
  const market = parsed?.market || match[1].toUpperCase();
  const code = parsed?.code || match[2].toUpperCase();
  return { market, code, name: code };
}

function parseFilterCookie(raw?: string | null): { selected: "all" | AuthorId; duanCategory: "all" | DuanCategory; page: number; symbol: string } {
  const fallback = { selected: "all" as const, duanCategory: "all" as const, page: 1, symbol: "" };
  if (!raw) return fallback;
  const params = new URLSearchParams(raw);
  const person = params.get("person");
  const cat = params.get("cat");
  const page = Number(params.get("page") || "1");
  const symbol = params.get("symbol") || "";
  return {
    selected: person === "trump" || person === "duan" ? person : "all",
    duanCategory: cat === "hot" || cat === "original" || cat === "longform" ? cat : "all",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    symbol: /^[A-Za-z]{2,5}[:.][A-Za-z0-9._-]{1,16}$/.test(symbol) ? symbol.toUpperCase() : ""
  };
}

const LINK_CLASS = "inline bg-transparent p-0 font-semibold text-brand-deep hover:underline";
const MENTION_CLASS = "inline font-semibold text-[#1d9bf0]";

function PostImages({ urls }: { urls?: string[] }) {
  const list = localUrls(urls).slice(0, 4);
  if (!list.length) return null;
  return (
    <PhotoProvider
      bannerVisible
      maskClosable
      pullClosable
      toolbarRender={({ onScale, scale }) => (
        <>
          <button type="button" className="PhotoView-Slider__toolbarIcon" aria-label="缩小" title="缩小" onClick={() => onScale(scale - 1)}>
            <IconMinus size={18} stroke={2} />
          </button>
          <button type="button" className="PhotoView-Slider__toolbarIcon" aria-label="放大" title="放大" onClick={() => onScale(scale + 1)}>
            <IconPlus size={18} stroke={2} />
          </button>
        </>
      )}
    >
      <div className={`mt-3 grid gap-2 ${list.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
        {list.map((url) => (
          <PhotoView key={url} src={url}>
            <img
              src={url}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(event) => { event.currentTarget.style.display = "none"; }}
              className={`w-full cursor-pointer overflow-hidden rounded-xl border border-edge bg-bg-gray dark:border-white/10 dark:bg-white/[.04] ${list.length === 1 ? "max-h-[32rem] object-contain" : "h-36 object-cover"}`}
            />
          </PhotoView>
        ))}
      </div>
    </PhotoProvider>
  );
}

function mentionHref(author: AuthorId | undefined, name: string) {
  if (author === "trump") return `https://truthsocial.com/@${encodeURIComponent(name)}`;
  return `https://xueqiu.com/n/${encodeURIComponent(name)}`;
}

/** 单条评论：头像与名字行顶对齐（主流社交网站都是这样排，垂直居中会显得错位）。 */
function CommentRow({ comment }: { comment: PostComment }) {
  return (
    <div className="flex items-start gap-2.5">
      <SafeAssetImage
        src={comment.avatar}
        alt=""
        className="h-7 w-7 flex-none rounded-full bg-bg-gray object-cover"
        fallback={<span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-bg-gray text-[10px] font-bold text-muted">{(comment.name || "?").slice(0, 1)}</span>}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
          <span className="min-w-0 truncate font-semibold text-ink dark:text-white/85">{comment.name}</span>
          {comment.replyTo ? <span className="flex-none text-muted">回复 @{comment.replyTo}</span> : null}
          {comment.createdAt ? <><span className="flex-none text-faint">·</span><time className="flex-none text-muted" dateTime={comment.createdAt} title={formatPostTime(comment.createdAt)}>{formatRelativeTime(comment.createdAt)}</time></> : null}
        </div>
        <p className="mt-1 whitespace-pre-line break-words text-[13px] leading-6 text-ink-2 dark:text-slate-300">{comment.text}</p>
        {comment.likes ? <p className="mt-1 flex items-center gap-1 text-[11px] tabular-nums text-muted"><IconThumbUp size={12} stroke={1.8} />赞 {comment.likes}</p> : null}
      </div>
    </div>
  );
}

/** 二级评论页：原帖 + 全部评论（评论很多时从「评论 N」图标点进来）。 */
function TradingCommentsPanel({ post, author, holdings, onStock, onBack }: { post: Post; author: (typeof PEOPLE)[number]; holdings: HoldingHint[]; onStock: (item: HoldingHint) => void; onBack: () => void }) {
  const text = (post.textZh || post.text || "").trim();
  const total = post.replies && post.replies > (post.comments?.length ?? 0) ? post.replies : post.comments?.length ?? 0;
  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-4 py-3 dark:border-white/10 sm:px-5">
        <button type="button" onClick={onBack} aria-label="返回动态" className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-bg-gray dark:hover:bg-white/[.07]"><IconChevronLeft size={18} /></button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold text-ink dark:text-white">评论</h2>
          <p className="truncate text-[11px] text-faint">{total ? "共 " + total + " 条" : "暂无评论"} · {author.name}</p>
        </div>
        <a href={post.originalUrl} target="_blank" rel="noreferrer" className="ml-auto flex-none text-[11px] font-semibold text-brand-deep">去雪球查看 ↗</a>
      </header>
      {/* 不在这里再开一层滚动条：二级页跟着页面滚（主流社交的帖子详情就是这样） */}
      <div className="px-4 py-4 sm:px-5">
        <article className="flex gap-3">
          <Avatar src={author.avatar} name={author.name} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <strong className="text-ink dark:text-white">{author.name}</strong>
              <PlatformBadge platform={author.id} />
              <span className="text-muted">{author.handle}</span>
              <span className="text-faint">·</span>
              <time className="text-muted" dateTime={post.date}>{formatPostTime(post.date)}</time>
            </div>
            {post.replyTo ? <p className="mt-1 text-[11px] text-muted">回复 <a href={mentionHref(post.author, post.replyTo)} target="_blank" rel="noreferrer" className={MENTION_CLASS}>@{post.replyTo}</a> 的动态</p> : null}
            {text ? <PostBody text={text} holdings={holdings} onStock={onStock} author={post.author} /> : null}
            <PostImages urls={post.images} />
          </div>
        </article>
        <div className="mt-4 space-y-3.5 border-t border-edge pt-3.5 dark:border-white/10">
          {(post.comments ?? []).map((comment) => <CommentRow key={comment.id} comment={comment} />)}
          {post.replies && post.replies > (post.comments?.length ?? 0) ? (
            <a href={post.originalUrl} target="_blank" rel="noreferrer" className="inline-block text-[11px] font-semibold text-brand-deep">还有 {post.replies - (post.comments?.length ?? 0)} 条评论，去雪球查看 ↗</a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PostBody({
  text,
  holdings,
  onStock,
  author,
  lines = 5,
  className = "mt-2 whitespace-pre-line break-words text-[15px] leading-7 text-ink dark:text-slate-200"
}: {
  text: string;
  holdings: HoldingHint[];
  onStock: (item: HoldingHint) => void;
  author?: AuthorId;
  lines?: number;
  className?: string;
}) {
  const display = useMemo(() => normalizeTradingText(text), [text]);
  const parts = useMemo(() => splitTradingText(display, holdings), [display, holdings]);
  const [open, setOpen] = useState(false);
  const long = display.length > lines * 32;
  return (
    <div>
      <div
        className={className}
        style={!open && long ? { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}
      >
        {parts.map((part, index) => {
          if (part.type === "url") {
            return <a key={`${part.value}-${index}`} href={part.value} target="_blank" rel="noreferrer" className={`${LINK_CLASS} break-all`}>{part.value}</a>;
          }
          if (part.type === "mention") {
            return (
              <a key={`m-${part.name}-${index}`} href={mentionHref(author, part.name)} target="_blank" rel="noreferrer" className={MENTION_CLASS}>
                {part.value}
              </a>
            );
          }
          if (part.type === "stock") {
            return (
              <StockTextLink
                key={`${part.market}-${part.code}-${index}`}
                value={`$${part.name || part.code}(${part.code})$`}
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
      {long ? (
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-1 text-xs font-semibold text-brand-deep">
          {open ? "收起" : "展开"}
        </button>
      ) : null}
    </div>
  );
}

export default function TradingSquareView({ avatars, records = [], initialPosts = null, initialFilter = null }: { avatars?: Record<string, string>; records?: StockRecord[]; initialPosts?: Post[] | null; initialFilter?: string | null }) {
  // 首帧与服务端一致：优先用 SSR 下发的帖子快照（刷新时列表与作者头像立刻可见），
  // 没有快照才进入加载态；浏览器缓存和 URL 参数仍由 useLayoutEffect 接着恢复，避免水合报错。
  const [posts, setPosts] = useState<Post[]>(() => initialPosts ?? []);
  const [loading, setLoading] = useState(() => !(initialPosts && initialPosts.length));
  const [refreshingByAuthor, setRefreshingByAuthor] = useState<AuthorFlags>(emptyFlags);
  const [updatedByAuthor, setUpdatedByAuthor] = useState<AuthorTimes>(emptyTimes);
  const [seen, setSeen] = useState<AuthorTimes>(emptyTimes);
  /** 本次进入页面时的已读快照：帖子上的「新」角标按它判断，整个会话里保持可见 */
  const [seenOnLoad, setSeenOnLoad] = useState<AuthorTimes>(emptyTimes);
  // 筛选状态由 cookie 镜像预置（服务端首帧即正确），URL 在水合后依然是最终依据。
  const seeded = parseFilterCookie(initialFilter);
  const [selected, setSelected] = useState<"all" | AuthorId>(seeded.selected);
  const [duanCategory, setDuanCategory] = useState<"all" | DuanCategory>(seeded.duanCategory);
  const [page, setPage] = useState(seeded.page);
  const [detail, setDetail] = useState<{ market: string; code: string; name: string } | null>(() => parseSymbol(seeded.symbol));
  const [original, setOriginal] = useState<Record<string, boolean>>({});
  /** 评论默认收起，点评论图标才展开（一级页面保持清爽） */
  const [commentsOpen, setCommentsOpen] = useState<Record<string, boolean>>({});
  /** 评论很多时点进的二级评论页（≤10 条直接内联展开） */
  const [commentPost, setCommentPost] = useState<Post | null>(null);
  const [fixed, setFixed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const restored = useRef(false);
  const pollLeft = useRef(0);
  const { pos, dragging, onTitleMouseDown, windowRef } = useDraggableWindow("fire:trading-square-window-pos", fixed);
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

  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const query = readQuery();
    setSelected(query.selected);
    setDuanCategory(query.duanCategory);
    setPage(query.page);
    setDetail(parseSymbol(query.symbol));
    try { setFixed(localStorage.getItem("fire:trading-square-window-fixed") === "1"); } catch { /* ignore */ }
    const cached = readLocalFeed();
    if (cached) {
      // 本地缓存只用来補服务端窗口之外的历史，不能整份盖掉首帧已经渲染的新数据 ——
      // 之前直接 setPosts(cached.posts)，缓存比服务端旧时就会「先显示旧帖、等接口回来再跳回新的」。
      const merged = takeNewestByAuthor(mergeFeedPosts(cached.posts, initialPosts ?? []), TRADING_SQUARE_AUTHOR_LIMIT);
      setPosts(merged);
      setUpdatedByAuthor(cached.updatedByAuthor);
      const snapshot = readSeen(merged);
      setSeen(snapshot);
      setSeenOnLoad(snapshot);
      setLoading(false);
      writeLocalFeed(merged, cached.updatedAt, cached.updatedByAuthor);
    } else {
      const snapshot = readSeen([]);
      setSeen(snapshot);
      setSeenOnLoad(snapshot);
    }
    setHydrated(true);
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
        const response = await fetch("/api/trading-square/feed", { cache: "no-store", signal: AbortSignal.timeout(FEED_FETCH_MS) });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as FeedPayload;
        if (!active) return;
        const nextUpdated = data.updatedByAuthor ?? emptyTimes();
        setPosts((current) => {
          const nextPosts = takeNewestByAuthor(mergeFeedPosts(current, data.posts ?? []), TRADING_SQUARE_AUTHOR_LIMIT);
          writeLocalFeed(nextPosts, data.updatedAt ?? null, nextUpdated);
          return nextPosts;
        });
        setUpdatedByAuthor(nextUpdated);
        setRefreshingByAuthor(data.refreshingByAuthor ?? emptyFlags());
        if (data.refreshing || Object.values(data.refreshingByAuthor ?? {}).some(Boolean)) pollLeft.current = Math.max(pollLeft.current, 12);
      } catch {
        /* keep existing cache on screen */
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const refreshing = Object.values(refreshingByAuthor).some(Boolean);

  useEffect(() => {
    if (!refreshing || pollLeft.current <= 0) return;
    const timer = window.setTimeout(() => {
      pollLeft.current -= 1;
      void fetch("/api/trading-square/feed", { cache: "no-store", signal: AbortSignal.timeout(FEED_FETCH_MS) })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: FeedPayload | null) => {
          if (!data) return;
          const nextUpdated = data.updatedByAuthor ?? emptyTimes();
          setPosts((current) => {
            const nextPosts = takeNewestByAuthor(mergeFeedPosts(current, data.posts ?? []), TRADING_SQUARE_AUTHOR_LIMIT);
            writeLocalFeed(nextPosts, data.updatedAt ?? null, nextUpdated);
            return nextPosts;
          });
          setUpdatedByAuthor(nextUpdated);
          const nextRefreshing: AuthorFlags = {};
          Object.entries(data.refreshingByAuthor ?? {}).forEach(([author, value]) => {
            nextRefreshing[author] = Boolean(value) && pollLeft.current > 0;
          });
          setRefreshingByAuthor(nextRefreshing);
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
  const safePage = visible.length === 0 ? Math.max(1, page) : Math.min(page, pages);
  const pagePosts = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  // 新动态与「上次看过的」之间的分界（当前页内的下标，-1 = 本页没有分界）
  const newBoundary = unseenBoundaryIndex(pagePosts, seenOnLoad);
  const newAboveBoundary = newBoundary < 0 ? 0 : pagePosts.slice(0, newBoundary + 1).filter((post) => isUnseenPost(post, seenOnLoad)).length;

  useEffect(() => {
    if (selected !== "duan" && duanCategory !== "all") setDuanCategory("all");
  }, [duanCategory, selected]);

  useEffect(() => {
    if (!hydrated) return;
    writeQuery(selected, duanCategory, safePage, detail ? `${detail.market}:${detail.code}` : "");
  }, [detail, duanCategory, hydrated, safePage, selected]);

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
  // 首屏位置由 app/layout.tsx 的 head 同步脚本写进 :root 的 CSS 变量（绘制前生效），
  // 这里只在已知非零位置时才用 inline 覆盖，避免刷新时先画在默认位置再跳到保存位置。
  const windowStyle = pos.x || pos.y ? ({ "--trading-x": `${pos.x}px`, "--trading-y": `${pos.y}px` } as CSSProperties) : undefined;
  // 加载完成前不显示「尚未同步 / 0 条」这类文字：让人感觉是在原处等内容出现，而不是发文被清空了
  const allFreshness = latestTime(updatedByAuthor) ? formatUpdatedAt(latestTime(updatedByAuthor)) : (refreshing ? "正在检查更新" : "");
  const personFreshness = selected === "all" ? "" : refreshingByAuthor[selected] ? "正在检查更新" : formatUpdatedAt(updatedByAuthor[selected] ?? null);
  const newCounts = useMemo(() => unseenCounts(posts, seen), [posts, seen]);
  const followed = detail ? records.some((record) => {
    const market = record.market.toUpperCase();
    return market === detail.market && normalizeCode(record.code, market) === detail.code;
  }) : false;

  if (commentPost) {
    const author = people.find((person) => person.id === commentPost.author) ?? people[0];
    return (
      <main ref={windowRef} style={windowStyle} className={`mx-auto w-full max-w-[800px] overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#10151d] md:[transform:translate(var(--trading-x,0px),var(--trading-y,0px))]`}>
        <div style={{ animation: "fade-in .25s ease" }}>
          <TradingCommentsPanel post={commentPost} author={author} holdings={holdings} onStock={openStock} onBack={() => setCommentPost(null)} />
        </div>
      </main>
    );
  }

  if (detail) {
    return (
      <main ref={windowRef} style={windowStyle} className={`mx-auto w-full max-w-[800px] overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#10151d] md:[transform:translate(var(--trading-x,0px),var(--trading-y,0px))] ${dragging ? "select-none" : ""}`}>
        <div style={{ animation: "fade-in .25s ease" }}>
          <StockDetailView market={detail.market} code={detail.code} name={detail.name} onBack={() => setDetail(null)} followed={followed} />
        </div>
      </main>
    );
  }

  return (
    <main ref={windowRef} style={windowStyle} className={`mx-auto grid w-full max-w-[800px] overflow-hidden rounded-2xl border border-edge bg-white shadow-card dark:bg-[#10151d] md:grid-cols-[200px_minmax(0,1fr)] md:[transform:translate(var(--trading-x,0px),var(--trading-y,0px))] ${dragging ? "select-none" : ""}`}>
      <aside className="flex gap-2 overflow-x-auto border-b border-edge p-3 dark:border-white/10 md:block md:overflow-visible md:border-b-0 md:border-r">
        <button type="button" aria-pressed={selected === "all"} onClick={() => changePerson("all")} className={`flex min-w-[142px] items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-bg-gray active:scale-[.98] dark:hover:bg-white/[.035] md:mb-1 md:w-full md:min-w-0 ${selected === "all" ? "bg-brand-light dark:bg-[#1a202a]" : ""}`}>
          <ActivityIcon />
          <div className="min-w-0">
            <strong className="block text-sm text-ink dark:text-white">全部动态</strong>
            <span className="text-xs tabular-nums text-muted">{posts.length ? `${posts.length} 条` : ""}</span>
          </div>
        </button>
        {orderedPeople.map((person) => (
          <button key={person.id} type="button" aria-pressed={selected === person.id} onClick={() => changePerson(person.id)} className={`flex min-w-[142px] items-center gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-bg-gray active:scale-[.98] dark:hover:bg-white/[.035] md:mb-1 md:w-full md:min-w-0 ${selected === person.id ? "bg-brand-light dark:bg-[#1a202a]" : ""}`}>
            <Avatar src={person.avatar} name={person.name} badge={newCounts[person.id] || 0} />
            <div className="min-w-0">
              <strong className="flex items-center truncate text-sm text-ink dark:text-white">{person.name}<PlatformBadge platform={person.id} /></strong>
              <span className="block truncate text-xs text-muted">{person.platform}</span>
            </div>
          </button>
        ))}
      </aside>
      <section className="min-w-0">
        <header onMouseDown={onTitleMouseDown} title={fixed ? undefined : "按住拖动窗口"} className={`border-b border-edge px-4 py-4 dark:border-white/10 sm:px-5 ${fixed ? "" : "md:cursor-grab md:active:cursor-grabbing"}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-ink dark:text-white">{selected === "all" ? "全部动态" : people.find((person) => person.id === selected)?.name}</h1>
              {selected === "all" && allFreshness ? <p className="mt-0.5 text-[11px] text-faint">{allFreshness}</p> : null}
              {personFreshness ? <p className="mt-0.5 text-[11px] text-faint">{personFreshness}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs tabular-nums text-muted">{loading ? "" : `${visible.length} 条`}</span>
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
          ) : pagePosts.map((post, index) => {
            const showOriginal = original[post.id] === true;
            const author = people.find((person) => person.id === post.author) ?? people[0];
            const bodyText = showOriginal ? post.text : (post.textZh ?? post.text);
            const displayText = (bodyText || "").trim();
            return (
              <Fragment key={`${post.author}-${post.id}`}>
              <article className="px-4 py-5 sm:px-5">
                <div className="flex gap-3">
                  <Avatar src={author.avatar} name={author.name} large />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      {/* 未读圆点：主流阅读器（Gmail / Feedly / Inoreader）都用「一个小圆点」表示这条没看过，
                          并且放在标题行最前面，比在时间后面贴一枚文字角标轻得多 */}
                      {isUnseenPost(post, seenOnLoad) ? (
                        <span
                          role="img"
                          aria-label="上次访问之后的新动态"
                          title="上次访问之后的新动态"
                          className="h-1.5 w-1.5 flex-none rounded-full bg-up dark:bg-[#ff8a8a]"
                        />
                      ) : null}
                      <strong className="text-ink dark:text-white">{author.name}</strong>
                      <PlatformBadge platform={author.id} />
                      <span className="text-muted">{author.handle}</span>
                      <span className="text-faint">·</span>
                      <time className="text-muted" dateTime={post.date}>{formatPostTime(post.date)}</time>
                    </div>
                    {post.replyTo && (
                      <p className="mb-1.5 text-[11px] text-muted">
                        回复 <a href={mentionHref(post.author, post.replyTo)} target="_blank" rel="noreferrer" className={MENTION_CLASS}>@{post.replyTo}</a> 的动态
                      </p>
                    )}
                    {displayText ? <PostBody text={displayText} holdings={holdings} onStock={openStock} author={post.author} /> : null}
                    <PostImages urls={post.images} />
                    {post.comments?.length && commentsOpen[post.id] ? (
                      <div className="mt-3 border-t border-edge pt-3 dark:border-white/10">
                        <div className="flex items-center justify-between gap-3 text-[11px] text-muted">
                          <span className="tabular-nums">评论 {post.comments.length}</span>
                          <a href={post.originalUrl} target="_blank" rel="noreferrer" className="flex-none font-semibold text-brand-deep">全部评论 ↗</a>
                        </div>
                        <ul className="mt-2.5 space-y-3.5">
                          {(post.comments ?? []).map((comment) => <CommentRow key={comment.id} comment={comment} />)}
                        </ul>
                        {post.replies && post.replies > post.comments.length ? (
                          <a href={post.originalUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-[11px] font-semibold text-brand-deep">还有 {post.replies - post.comments.length} 条评论，去雪球查看 ↗</a>
                        ) : null}
                      </div>
                    ) : null}
                    {post.quote && (
                      <div className="mt-3 rounded-xl border border-edge bg-bg-gray/60 px-3 py-2.5 dark:border-white/10 dark:bg-white/[.04]">
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-muted">
                          <SafeAssetImage
                            src={post.quote.avatar}
                            alt=""
                            className="h-4 w-4 flex-none rounded-full bg-bg-gray object-cover"
                            fallback={<span className="grid h-4 w-4 flex-none place-items-center rounded-full bg-bg-gray text-[9px] font-bold text-muted">{(post.quote.name || "?").slice(0, 1)}</span>}
                          />
                          <span className="min-w-0 truncate">{post.quote.name}</span>
                        </p>
                        <PostBody
                          text={post.quote.text}
                          holdings={holdings}
                          onStock={openStock}
                          author={post.author}
                          lines={4}
                          className="mt-1 whitespace-pre-line break-words text-[13px] leading-6 text-ink-2 dark:text-slate-300"
                        />
                        <PostImages urls={post.quote.images} />
                        {post.quote.url && (
                          <a href={post.quote.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-block text-[11px] font-semibold text-brand-deep">查看原动态 ↗</a>
                        )}
                      </div>
                    )}
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
                      <a href={post.originalUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-deep">查看原文 ↗</a>
                      {post.comments?.length ? (
                        <button
                          type="button"
                          onClick={() => (post.comments && post.comments.length > INLINE_COMMENT_LIMIT ? setCommentPost(post) : setCommentsOpen((value) => ({ ...value, [post.id]: !value[post.id] })))}
                          aria-expanded={Boolean(commentsOpen[post.id])}
                          className={`flex items-center gap-1 font-semibold transition-colors hover:text-ink dark:hover:text-white ${commentsOpen[post.id] ? "text-ink dark:text-white" : ""}`}
                        >
                          <IconMessageCircle size={14} />评论 {post.comments.length}
                        </button>
                      ) : null}
                      {post.textZh && (
                        <button type="button" onClick={() => setOriginal((value) => ({ ...value, [post.id]: !showOriginal }))} className="font-semibold">
                          {showOriginal ? "中文" : "原文"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </article>
              {/* 未读分界：照微信「以下是新消息」/ Telegram 的做法，把一行小字压在「本来就存在的那条帖间分隔线」中间 ——
                  不额外画线、也不用红色（红字 + 红细线夹在两条分隔线之间，深色下像一道脏边）。
                  列表是倒序，新动态在最上面，所以这条线标的是「以上为新动态」 */}
              {index === newBoundary ? (
                <div className="relative flex h-0 items-center justify-center">
                  <span className="relative z-[1] flex-none bg-white px-2 text-[10px] font-medium text-faint dark:bg-[#10151d]">以上 {newAboveBoundary} 条为新动态</span>
                </div>
              ) : null}
              </Fragment>
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
