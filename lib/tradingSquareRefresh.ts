import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sniffImageExt } from "@/lib/imageSecurity";
import { isAllowedRemoteImageUrl, isLocalPostImageUrl, normalizeXueqiuAvatar, originalRemoteImageUrl } from "@/lib/tradingSquareImages";
import { getSiteSettings } from "@/lib/settings";
import { readJsonFile, writeJsonAtomic } from "@/lib/tradingSquareCache";
import { normalizeTradingText } from "@/lib/tradingSquareText";
import { COMMENTS_CACHE_VERSION, commentsFilePath, mapXueqiuComment, readDuanComments, type CommentsCache, type XueqiuComment } from "@/lib/tradingSquareComments";
import { backfillTrumpTranslations, translateTrumpPostsNow } from "@/lib/tradingSquareTranslate";
import { proxyFetch } from "@/lib/net";

const DATA = path.join(process.cwd(), "data");
const TRUMP_FILE = path.join(DATA, "trump-posts.json");
const DUAN_FILE = path.join(DATA, "duan-posts.json");
const TRUMP_SOURCE = "https://trumpstruth.org/";
const DUAN_USER = "1247347556";

export type TrumpPost = { id: string; date: string; text: string; originalUrl: string; archiveUrl: string; images?: string[] };
type DuanCategory = "hot" | "original" | "longform";
export type Quote = { name: string; text: string; url?: string; images?: string[]; avatar?: string };
// reply：这条是不是「回复某人」。正文会清掉开头的「回复@某人:」（那是雪球页面元素，不是作者写的），
// 所以是否回复必须在清洗前记下来，补抓引用时还要用。
// replyTo：「回复@某人」里的那个人（正文清洗后前缀没了，但界面上要用它标出「回复 @某人」）。
export type DuanPost = { id: string; date: string; text: string; originalUrl: string; categories: DuanCategory[]; replies?: number; likes?: number; quote?: Quote; images?: string[]; reply?: boolean; replyTo?: string };

type XueqiuStatus = {
  id?: number | string;
  created_at?: number | string;
  text?: string;
  description?: string;
  title?: string;
  like_count?: number;
  reply_count?: number;
  comments_count?: number;
  target?: string;
  pic?: unknown;
  pics?: unknown;
  pic_urls?: unknown;
  original_pic?: unknown;
  bmiddle_pic?: unknown;
  thumbnail_pic?: unknown;
  cover_pic?: unknown;
  firstImg?: string;
  image_info_list?: Array<{ filename?: string; url?: string; original?: string }>;
  user?: { id?: number | string; screen_name?: string; name?: string; profile_image_url?: string };
  retweeted_status?: XueqiuStatus;
  retweet_status?: XueqiuStatus;
  reply_comment?: XueqiuStatus;
  reply_status?: XueqiuStatus;
  quoted_status?: XueqiuStatus;
  comment?: XueqiuStatus;
};

let xueqiuCookie = "";

function mergeSetCookie(existing: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const part of existing.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name && rest.length) map.set(name, rest.join("="));
  }
  for (const raw of setCookies) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function xueqiuErrorCode(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function xueqiuFetch(pathAndQuery: string): Promise<unknown | null> {
  // A configured (logged-in) Xueqiu cookie authenticates api.xueqiu.com
  // (anonymous requests return error 400016). xueqiu.com HTML hosts are behind
  // Aliyun WAF and often return a 200 challenge page instead of JSON, so API
  // host is tried first.
  const configured = getSiteSettings().xueqiuCookie;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    Referer: "https://xueqiu.com/u/slowisquick",
    Origin: "https://xueqiu.com",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  };
  const cookie = configured || xueqiuCookie;
  if (cookie) headers.Cookie = cookie;
  const urls = [`https://api.xueqiu.com${pathAndQuery}`, `https://xueqiu.com${pathAndQuery}`];
  for (const url of urls) {
    try {
      const response = await proxyFetch(url, { headers, signal: AbortSignal.timeout(12_000), cache: "no-store" });
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      if (setCookies.length && !configured) {
        xueqiuCookie = mergeSetCookie(xueqiuCookie, setCookies);
        headers.Cookie = xueqiuCookie;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("json")) continue;
      const json = await response.json() as { error_code?: unknown };
      // Xueqiu uses error_code 0 or "0" for success; a truthy string "0" must not be treated as failure.
      if (json && typeof json === "object" && xueqiuErrorCode(json.error_code) !== 0) continue;
      return json;
    } catch {
      /* try next host */
    }
  }
  return null;
}

async function warmXueqiuSession() {
  if (getSiteSettings().xueqiuCookie) return; // configured session bypasses WAF
  if (xueqiuCookie) return;
  try {
    const response = await proxyFetch("https://xueqiu.com/u/slowisquick", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      signal: AbortSignal.timeout(4000),
      cache: "no-store"
    });
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (setCookies.length) xueqiuCookie = mergeSetCookie(xueqiuCookie, setCookies);
  } catch {
    /* continue without pre-warmed cookies */
  }
}

let trumpRunning = false;
let duanRunning = false;

function clean(value: string) {
  return normalizeTradingText(value);
}

export function postTimestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function toIsoDate(value: string): string {
  const time = postTimestamp(value);
  return time ? new Date(time).toISOString() : value;
}

function absoluteUrl(value: string): string {
  const url = value.trim();
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function isPostImage(url: string): boolean {
  if (!isAllowedRemoteImageUrl(url)) return false;
  if (/avatar|logo\.svg|emoji|profile_image|accounts\/avatars|preview_cards|status-info__avatar/i.test(url)) return false;
  return /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) || /xqimg|imedao|linodeobjects|\/attachments\/|media_attachments/i.test(url);
}

function collectUrls(value: unknown, into: string[]) {
  if (!value) return;
  if (typeof value === "string") {
    if (value.includes(",") && /https?:/i.test(value)) {
      value.split(",").forEach((part) => collectUrls(part.trim(), into));
      return;
    }
    const url = absoluteUrl(value);
    if (isPostImage(url)) into.push(url);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, into));
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    collectUrls(record.url ?? record.src ?? record.pic ?? record.original ?? record.large ?? record.original_pic, into);
  }
}

function uniqueImages(urls: string[]): string[] | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  urls.forEach((url) => {
    const upgraded = originalRemoteImageUrl(url);
    if (!isPostImage(upgraded) && !isPostImage(url)) return;
    if (seen.has(upgraded)) return;
    seen.add(upgraded);
    list.push(upgraded);
  });
  return list.length ? list.slice(0, 9) : undefined;
}

function imagesFromHtml(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((match) => absoluteUrl(match[1]));
}

function extractXueqiuImages(item: XueqiuStatus): string[] | undefined {
  const urls: string[] = [];
  collectUrls(item.original_pic, urls);
  collectUrls(item.image_info_list, urls);
  (item.image_info_list || []).forEach((info) => {
    if (info?.filename) collectUrls(`https://xqimg.imedao.com/${info.filename}`, urls);
  });
  imagesFromHtml(String(item.text || item.description || "")).forEach((url) => collectUrls(url, urls));
  collectUrls(item.pics, urls);
  collectUrls(item.pic_urls, urls);
  collectUrls(item.bmiddle_pic, urls);
  collectUrls(item.cover_pic, urls);
  collectUrls(item.pic, urls);
  collectUrls(item.firstImg, urls);
  collectUrls(item.thumbnail_pic, urls);
  return uniqueImages(urls);
}

function extractTrumpImages(block: string): string[] | undefined {
  const hrefs = [...block.matchAll(/status-attachment__link[^>]*href=["']([^"']+)["']/gi)].map((match) => absoluteUrl(match[1]));
  return uniqueImages([...imagesFromHtml(block), ...hrefs].filter((url) => isPostImage(url)));
}

const IMAGE_DIR = path.join(process.cwd(), "public", "uploads", "trading-square");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const localIndex = new Map<string, Map<string, string>>();

function sourceKey(url: string): string {
  return createHash("sha1").update(url.replace(/!.*$/, "")).digest("hex").slice(0, 16);
}

function lookupLocal(author: string, key: string): string | undefined {
  let folder = localIndex.get(author);
  if (!folder) {
    folder = new Map();
    try {
      for (const name of fs.readdirSync(path.join(IMAGE_DIR, author))) {
        const local = `/uploads/trading-square/${author}/${name}`;
        if (isLocalPostImageUrl(local)) folder.set(name.replace(/\.[^.]+$/, ""), local);
      }
    } catch {
      /* first download creates the folder */
    }
    localIndex.set(author, folder);
  }
  return folder.get(key);
}

function rememberLocal(author: string, key: string, url: string) {
  let folder = localIndex.get(author);
  if (!folder) {
    folder = new Map();
    localIndex.set(author, folder);
  }
  folder.set(key, url);
}

function isTinyLocalImage(local: string): boolean {
  try {
    return fs.statSync(path.join(process.cwd(), "public", local.replace(/^\//, ""))).size < 20_000;
  } catch {
    return true;
  }
}

async function downloadImage(author: string, url: string): Promise<string | undefined> {
  if (author !== "trump" && author !== "duan") return undefined;
  if (isLocalPostImageUrl(url)) return url;
  const fetchUrl = originalRemoteImageUrl(url);
  if (!isAllowedRemoteImageUrl(fetchUrl)) return undefined;
  const key = sourceKey(fetchUrl);
  const existing = lookupLocal(author, key);
  if (existing && isLocalPostImageUrl(existing) && !isTinyLocalImage(existing)) return existing;
  try {
    const referer = /xueqiu|imedao|xqimg/i.test(fetchUrl) ? "https://xueqiu.com/" : "https://trumpstruth.org/";
    const response = await proxyFetch(fetchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Referer: referer,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "follow"
    });
    if (!response.ok) return undefined;
    if (!isAllowedRemoteImageUrl(response.url || fetchUrl)) return undefined;
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return undefined;
    const ext = sniffImageExt(buf);
    if (!ext || ext === "svg" || ext === "ico") return undefined;
    const dir = path.join(IMAGE_DIR, author);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${key}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    const local = `/uploads/trading-square/${author}/${filename}`;
    if (!isLocalPostImageUrl(local)) return undefined;
    rememberLocal(author, key, local);
    return local;
  } catch {
    return undefined;
  }
}

function remoteImageUrls(urls?: string[]): string[] {
  return (urls || []).filter((url) => /^https?:\/\//i.test(url) && isPostImage(url));
}

async function localizeUrlMap(author: string, urls: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(remoteImageUrls(urls))];
  for (let index = 0; index < unique.length; index += 4) {
    const batch = unique.slice(index, index + 4);
    await Promise.all(batch.map(async (url) => {
      const local = await downloadImage(author, url);
      if (local) map.set(url, local);
    }));
  }
  return map;
}

/**
 * 头像专用下载：`localizeUrlMap` 会按「正文配图」过滤掉含 avatar/profile 的地址（那是为了排除
 * 正文里混进的作者头像），而评论者 / 引用作者的头像正好在这个过滤范围内，所以单独走这条通道。
 */
async function localizeAvatars(author: string, urls: (string | undefined)[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(urls.filter((url): url is string => Boolean(url) && /^https?:\/\//i.test(url as string) && !isLocalPostImageUrl(url as string)))];
  for (let index = 0; index < unique.length; index += 4) {
    const batch = unique.slice(index, index + 4);
    await Promise.all(batch.map(async (url) => {
      const local = await downloadImage(author, url);
      if (local) map.set(url, local);
    }));
  }
  return map;
}

export function keepLocalImages(urls?: string[], map?: Map<string, string>): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  (urls || []).forEach((url) => {
    const local = isLocalPostImageUrl(url) ? url : map?.get(url);
    if (!local || !isLocalPostImageUrl(local) || seen.has(local)) return;
    seen.add(local);
    out.push(local);
  });
  return out.length ? out : undefined;
}

export function withoutRemoteImages<T extends { images?: string[]; quote?: { images?: string[] } }>(post: T, map?: Map<string, string>): T {
  const next = { ...post };
  const images = keepLocalImages(post.images, map);
  if (images) next.images = images;
  else delete next.images;
  if (next.quote) {
    const quote = { ...next.quote };
    const quoteImages = keepLocalImages(quote.images, map);
    if (quoteImages) quote.images = quoteImages;
    else delete quote.images;
    next.quote = quote;
  }
  return next;
}

/**
 * 取 `class="<className>"`（可带额外属性）那个 div 的完整内部 HTML。
 * 按 div 深度配对，既不要求类名后面紧跟 `>`（归档站后来加了 data-post-preview 之类的属性），
 * 也不会被正文里的内层 </div> 提前截断。
 */
function innerHtmlOfDiv(html: string, className: string): string {
  const start = html.search(new RegExp(`<div class="${className}"[^>]*>`, "i"));
  if (start < 0) return "";
  const open = html.indexOf(">", start) + 1;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = open;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, match.index);
  }
  return html.slice(open);
}

/** 解析归档站列表页（导出以便回归测试：这站改过两次标记，改坏时是静默失效）。 */
export function parseTrumpPage(html: string, source: string): TrumpPost[] {
  return html.split('<div class="status"').slice(1).map((tail, index) => {
    const block = tail.split('<div class="status"')[0];
    // 归档站把日期改成了 <time datetime="2026-09-17T13:00:22+00:00">September 17, 2026, 9:00 AM</time>：
    // 旧正则（直接取 meta-item 的文本）取不到日期，整页会被过滤成 0 条、刷新等于没刷新。
    // 现在优先读 datetime 属性，再退回旧的纯文本写法，最后用通用日期串兜底。
    const date = toIsoDate(
      block.match(/<time[^>]*datetime="([^"]+)"/i)?.[1]
      ?? block.match(/status-info__meta-item">([^<]+,\s*\d{4},\s*[^<]+)</)?.[1]
      ?? block.match(/([A-Z][a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2} ?[AP]M)/)?.[1]
      ?? ""
    );
    const originalUrl = block.match(/href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/[^" ]+)"/)?.[1] ?? "https://truthsocial.com/@realDonaldTrump";
    const content = clean(innerHtmlOfDiv(block, "status__content"));
    const rawArchive = block.match(/data-status-url="([^" ]+)/)?.[1] ?? source;
    const archiveUrl = rawArchive.startsWith("http") ? rawArchive : `https://trumpstruth.org/statuses/${rawArchive}`;
    const archiveId = archiveUrl.split("/").pop() || "";
    const truthId = originalUrl.match(/\/(\d{8,})$/)?.[1] || "";
    const id = /^\d{4,}$/.test(archiveId) ? archiveId : truthId || String(index);
    const images = extractTrumpImages(block);
    return {
      id,
      date,
      text: content,
      originalUrl,
      archiveUrl,
      ...(images ? { images } : {})
    };
  }).filter((post) => post.date && (post.text || post.images?.length));
}

export function readTrumpPosts(): TrumpPost[] {
  return readJsonFile<TrumpPost[]>(TRUMP_FILE, []);
}

export function readDuanPosts(): DuanPost[] {
  return readJsonFile<DuanPost[]>(DUAN_FILE, []);
}

/** 有缓存时只翻到与旧帖重叠为止；不再按天数丢弃历史。 */
export async function refreshTrumpPosts(): Promise<TrumpPost[]> {
  if (trumpRunning) return readTrumpPosts();
  trumpRunning = true;
  const existing = readTrumpPosts();
  const known = new Set(existing.map((post) => post.id));
  const settings = getSiteSettings();
  const source = settings.trumpArchiveApiUrl || TRUMP_SOURCE;
  const incoming: TrumpPost[] = [];
  let nextUrl = source;
  let overlap = 0;
  const maxPages = existing.length < 200 ? 40 : 5;
  try {
    for (let page = 0; page < maxPages && nextUrl; page += 1) {
      let html = "";
      try {
        const response = await fetch(nextUrl, {
          headers: { "User-Agent": "Fire/1.0 public archive reader" },
          cache: "no-store",
          // 归档站有时单页要 2 秒以上；4 秒太紧会把整次刷新打断（异常直接抛出去、一条都写不进来）
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) break;
        html = await response.text();
      } catch {
        // 单页失败就停在已抓到的内容上，不要让整次刷新失败
        break;
      }
      const parsed = parseTrumpPage(html, source);
      if (!parsed.length) break;
      for (const post of parsed) {
        if (known.has(post.id)) overlap += 1;
        else known.add(post.id);
        incoming.push(post);
      }
      const next = html.match(/<a href="([^"]*cursor=[^"]+)"[^>]*>Next Page/i)?.[1];
      nextUrl = next ? new URL(next.replace(/&amp;/g, "&"), source).toString() : "";
      if (existing.length >= 200 && overlap >= 2) nextUrl = "";
    }
    if (incoming.length) {
      const newest = [...incoming].sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
      await translateTrumpPostsNow(newest.slice(0, 15));
    }
    const localMap = await localizeUrlMap("trump", [
      ...incoming.flatMap((post) => post.images || []),
      ...existing.flatMap((post) => post.images || [])
    ]);
    const merged = new Map(existing.map((post) => [post.id, post]));
    incoming.forEach((post) => {
      const saved = merged.get(post.id);
      const images = keepLocalImages(post.images?.length ? post.images : saved?.images, localMap);
      const next = {
        ...saved,
        ...post,
        date: toIsoDate(post.date)
      };
      if (images) next.images = images;
      else delete next.images;
      merged.set(post.id, next);
    });
    const mergedPosts = Array.from(merged.values()).map((post) => withoutRemoteImages(post, localMap));
    try { writeJsonAtomic(TRUMP_FILE, mergedPosts); } catch { /* read-only deployments */ }
    void backfillTrumpTranslations(mergedPosts, 20);
    return mergedPosts;
  } catch {
    // 兜底：翻译 / 图片本地化等任何一步失败都不该让已有缓存白刷一轮
    return existing;
  } finally {
    trumpRunning = false;
  }
}

function duanCategories(text: string, likes = 0, replies = 0): DuanCategory[] {
  const values: DuanCategory[] = [];
  if (likes >= 500 || replies >= 100) values.push("hot");
  if (!/^\s*(回复|转发|\/\/|@)/.test(text)) values.push("original");
  if (text.length >= 240) values.push("longform");
  return values;
}

function asQuote(value: unknown): Quote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as XueqiuStatus;
  const user = item.user && typeof item.user === "object" ? item.user : {};
  const name = String(user.screen_name || user.name || "").trim();
  const text = clean(String(item.text || item.description || item.title || ""));
  if (!text) return undefined;
  const id = item.id != null ? String(item.id) : "";
  const uid = user.id != null ? String(user.id) : "";
  const images = extractXueqiuImages(item);
  const avatar = normalizeXueqiuAvatar(user.profile_image_url);
  return { name: name || "原动态", text, url: id && uid ? `https://xueqiu.com/${uid}/${id}` : undefined, ...(images ? { images } : {}), ...(avatar ? { avatar } : {}) };
}

function extractQuote(item: XueqiuStatus): Quote | undefined {
  return asQuote(item.reply_comment) || asQuote(item.reply_status) || asQuote(item.comment) || asQuote(item.retweeted_status) || asQuote(item.retweet_status) || asQuote(item.quoted_status);
}

/** 把雪球时间线里的一条状态转成站内结构（导出以便回归测试：这里有「转发帖被整条丢掉」的坑）。 */
export function mapDuanStatus(item: XueqiuStatus): DuanPost | null {
  const images = extractXueqiuImages(item);
  const rawText = item.text || item.description || item.title || "";
  const text = clean(rawText);
  const id = String(item.id || "");
  const quote = extractQuote(item);
  // 转发别人的帖子时，他自己的正文可能只有一个表情（例如 👍）、也没有自己的图片：
  // 这种帖要留下来（内容全在引用里），否则时间线上最新的一条会被整条丢掉。
  if (!id || (!text && !images?.length && !quote)) return null;
  const likes = Number(item.like_count || 0);
  const replies = Number(item.reply_count || item.comments_count || 0);
  const replyMatch = String(rawText).match(/^\s*回复\s*@([^\s:：]{1,40})\s*[:：]\s*/u);
  const reply = replyMatch ? true : undefined;
  return {
    id,
    date: typeof item.created_at === "number" ? new Date(item.created_at).toISOString() : new Date(item.created_at || Date.now()).toISOString(),
    text,
    originalUrl: `https://xueqiu.com/${DUAN_USER}/${item.id}`,
    categories: duanCategories(text, likes, replies),
    likes,
    replies,
    ...(reply ? { reply } : {}),
    ...(replyMatch?.[1] ? { replyTo: replyMatch[1] } : {}),
    ...(images ? { images } : {}),
    ...(quote && quote.text !== text ? { quote } : {})
  };
}

async function fillMissingQuotes(posts: DuanPost[]): Promise<DuanPost[]> {
  // 两种情况要补：1) 回复了别人但没抓到引用；2) 有引用但缺作者头像（多花一次详情请求补上）。
  // 只对最近这些帖子做，避免把几百条老帖全部重抓一遍。
  const recent = posts.slice(0, 24);
  const missing = recent.filter((post) => {
    if (post.quote && post.quote.avatar) return false;
    if (post.quote) return true;
    // 老缓存里的帖没有 reply 标记，再兜一层正文判断（清洗后开头的「回复@」没了，但 //@ 转发链还在）。
    return post.reply === true || /^\s*回复\s*@/.test(post.text) || /^\s*\/\/@/.test(post.text);
  }).slice(0, 24);
  if (!missing.length) return posts;
  const quotes = new Map<string, Quote>();
  const images = new Map<string, string[]>();
  for (let index = 0; index < missing.length; index += 3) {
    const batch = missing.slice(index, index + 3);
    await Promise.all(batch.map(async (post) => {
      const detail = await xueqiuFetch(`/statuses/show.json?id=${encodeURIComponent(post.id)}`) as XueqiuStatus | null;
      if (!detail) return;
      const quote = extractQuote(detail);
      if (quote && (quote.text !== post.text || (quote.avatar && !post.quote?.avatar))) quotes.set(post.id, quote);
      const pics = extractXueqiuImages(detail);
      if (pics?.length && !post.images?.length) images.set(post.id, pics);
    }));
  }
  if (!quotes.size && !images.size) return posts;
  return posts.map((post) => ({
    ...post,
    ...(quotes.has(post.id) ? { quote: quotes.get(post.id) } : {}),
    ...(images.has(post.id) ? { images: images.get(post.id) } : {})
  }));
}

/** 只刷新最近这些帖子的评论；他为「只有关注的人能评论」，多数帖子评论数为 0，请求量很小。 */
const COMMENT_REFRESH_POSTS = 24;
const COMMENT_PAGE_SIZE = 20;
/** 评论很多的帖子（>20 条）最多抓这么多页，够二级评论页展示；再多去雪球看 */
const COMMENT_MAX_PAGES = 3;
const COMMENT_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * 拉取帖子评论（别人在他帖子下面的留言）。
 * 省请求的两个条件：帖子评论数没变、且缓存不超过 30 分钟 —— 两者都满足就跳过这条帖子。
 */
async function refreshDuanComments(posts: DuanPost[], now = Date.now()): Promise<CommentsCache> {
  const cache = readDuanComments();
  const candidates = posts.filter((post) => (post.replies || 0) > 0).slice(0, COMMENT_REFRESH_POSTS);
  let changed = false;
  const pending = candidates.filter((post) => {
    const hit = cache[post.id];
    if (!hit || hit.version !== COMMENTS_CACHE_VERSION) return true;
    if (Number(hit.total) !== Number(post.replies || 0)) return true;
    const at = Date.parse(hit.updatedAt);
    return !Number.isFinite(at) || now - at > COMMENT_CACHE_TTL_MS;
  });
  if (pending.length) {
    for (let index = 0; index < pending.length; index += 3) {
      const batch = pending.slice(index, index + 3);
      await Promise.all(batch.map(async (post) => {
        const pages = post.replies && post.replies > COMMENT_PAGE_SIZE ? COMMENT_MAX_PAGES : 1;
        const raw: XueqiuComment[] = [];
        let reported = 0;
        for (let page = 1; page <= pages; page += 1) {
          const data = await xueqiuFetch(`/statuses/comments.json?id=${encodeURIComponent(post.id)}&count=${COMMENT_PAGE_SIZE}&page=${page}&reply=true&asc=false`) as { comments?: XueqiuComment[]; count?: number } | null;
          if (!data) break;
          if (page === 1) reported = Number(data.count ?? 0) || 0;
          const list = data.comments || [];
          raw.push(...list);
          if (list.length < COMMENT_PAGE_SIZE) break;
        }
        const seen = new Set<string>();
        const comments = raw
          .map(mapXueqiuComment)
          .filter((item): item is NonNullable<ReturnType<typeof mapXueqiuComment>> => item !== null)
          .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
        cache[post.id] = { updatedAt: new Date(now).toISOString(), total: reported || comments.length, comments, version: COMMENTS_CACHE_VERSION };
        changed = true;
      }));
    }
  }
  // 头像本地化也要跑：缓存里还留着远程头像时（比如刚升级完代码）也算「需要处理」
  const remoteAvatars = Object.values(cache)
    .flatMap((entry) => entry.comments.map((comment) => comment.avatar))
    .filter((url): url is string => Boolean(url) && !isLocalPostImageUrl(url as string));
  if (!changed && !remoteAvatars.length) return cache;

  // 下载失败就保留原地址，前端有首字母兜底
  const avatarMap = await localizeAvatars("duan", remoteAvatars);
  if (avatarMap.size) {
    for (const entry of Object.values(cache)) {
      for (const comment of entry.comments) {
        if (!comment.avatar || isLocalPostImageUrl(comment.avatar)) continue;
        const local = avatarMap.get(comment.avatar);
        if (local) comment.avatar = local;
      }
    }
  }
  writeJsonAtomic(commentsFilePath(), cache);
  return cache;
}

export async function refreshDuanPosts(): Promise<DuanPost[]> {
  if (duanRunning) return readDuanPosts();
  duanRunning = true;
  const existing = readDuanPosts();
  const known = new Set(existing.map((post) => post.id));
  const live: DuanPost[] = [];
  const maxPages = existing.length < 50 ? 15 : 8;
  try {
    await warmXueqiuSession();
    for (let page = 1; page <= maxPages; page += 1) {
      // /v4/...?type=0 只返回较早的原创帖，雪球上的新回复/转发不会出现。
      // /statuses/user_timeline.json 才是完整时间线（实测含 2026-09-10 的新帖）。
      const data = await xueqiuFetch(`/statuses/user_timeline.json?user_id=${DUAN_USER}&page=${page}&count=20`) as { statuses?: XueqiuStatus[] } | null;
      if (!data) break;
      const batch = (data.statuses || []).map(mapDuanStatus).filter((item): item is DuanPost => item !== null);
      if (!batch.length) break;
      let overlap = 0;
      for (const item of batch) {
        if (known.has(item.id)) overlap += 1;
        else known.add(item.id);
        live.push(item);
      }
      // 已经接到本地缓存里的旧帖，后面翻页只会更旧。
      if (overlap >= 3) break;
    }
    const quoted = await fillMissingQuotes(live);
    if (!quoted.length) return existing;
    // 评论只是附加信息：拉取失败不影响帖子本身
    try {
      await refreshDuanComments(quoted);
    } catch {
      /* ignore */
    }
    const remoteUrls = [
      ...quoted.flatMap((item) => [...(item.images || []), ...(item.quote?.images || [])]),
      ...existing.flatMap((item) => [...(item.images || []), ...(item.quote?.images || [])])
    ];
    const localMap = await localizeUrlMap("duan", remoteUrls);
    // 引用作者头像单独下载（会被 localizeUrlMap 的头像过滤挡掉）
    const avatarMap = await localizeAvatars("duan", [...quoted, ...existing].map((item) => item.quote?.avatar));
    const merged = new Map(existing.map((item) => [item.id, item]));
    quoted.forEach((item) => {
      const saved = merged.get(item.id);
      const images = keepLocalImages(item.images?.length ? item.images : saved?.images, localMap);
      const quoteSource = item.quote || saved?.quote;
      const quoteImages = quoteSource ? keepLocalImages(quoteSource.images?.length ? quoteSource.images : saved?.quote?.images, localMap) : undefined;
      const quoteAvatar = quoteSource?.avatar && !isLocalPostImageUrl(quoteSource.avatar) ? avatarMap.get(quoteSource.avatar) : quoteSource?.avatar;
      const next = {
        ...saved,
        ...item,
        quote: quoteSource ? { ...quoteSource, ...(quoteImages ? { images: quoteImages } : {}), ...(quoteAvatar || saved?.quote?.avatar ? { avatar: quoteAvatar || saved?.quote?.avatar } : {}) } : undefined,
        categories: Array.from(new Set([...(saved?.categories || []), ...item.categories]))
      };
      if (images) next.images = images;
      else delete next.images;
      if (next.quote && !quoteImages) delete next.quote.images;
      merged.set(item.id, next);
    });
    const posts = Array.from(merged.values()).map((item) => withoutRemoteImages(item, localMap)).sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
    try { writeJsonAtomic(DUAN_FILE, posts); } catch { /* read-only deployment */ }
    return posts;
  } catch {
    return existing;
  } finally {
    duanRunning = false;
  }
}

export function isTrumpRefreshing() {
  return trumpRunning;
}

export function isDuanRefreshing() {
  return duanRunning;
}
