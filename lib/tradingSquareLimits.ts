/**
 * 动态只保留「最近 N 天」：老帖是过去式，没有展示意义（2026-09-11 按用户要求）。
 * 磁盘缓存不删数据，只是接口与列表不再返回更早的内容；后续新帖照常更新。
 */
export const TRADING_SQUARE_RECENT_DAYS = 30;
/** 兜底上限：即便某作者 30 天内刷了很多，也不会把列表撑爆 */
export const TRADING_SQUARE_AUTHOR_LIMIT = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 需要按「最近 N 天」收敛的作者（段永平保持全量，用户明确要求不动） */
export const TRADING_SQUARE_RECENT_AUTHORS = ["trump"];

/** 只保留指定作者的最近 N 天帖子；其他作者的帖子原样返回 */
export function takeRecent<T extends { date?: string; author?: string }>(posts: T[], days = TRADING_SQUARE_RECENT_DAYS, now = Date.now()): T[] {
  const cutoff = now - days * DAY_MS;
  return posts.filter((post) => {
    if (!post.author || !TRADING_SQUARE_RECENT_AUTHORS.includes(post.author)) return true;
    const time = postTime(post.date);
    return time === 0 || time >= cutoff;
  });
}

/**
 * 列表收敛（服务端与客户端共用，口径只有一处）：
 * - 特朗普：只保留最近 N 天，并按 AUTHOR_LIMIT 兜底；
 * - 其他作者（段永平）：原样保留，不动。
 */
export function trimFeed<T extends { date?: string; author?: string }>(posts: T[]): T[] {
  const recent: T[] = [];
  const others: T[] = [];
  for (const post of posts) {
    if (post.author && TRADING_SQUARE_RECENT_AUTHORS.includes(post.author)) recent.push(post);
    else others.push(post);
  }
  return [...takeNewestByAuthor(recent, TRADING_SQUARE_AUTHOR_LIMIT), ...others];
}

function postTime(value?: string): number {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

export function takeNewest<T extends { date?: string }>(posts: T[], limit: number): T[] {
  if (posts.length <= limit) return posts;
  return posts
    .slice()
    .sort((a, b) => postTime(b.date) - postTime(a.date))
    .slice(0, limit);
}

export function takeNewestByAuthor<T extends { date?: string; author?: string }>(posts: T[], perAuthor: number): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  // 不截断时也要按时间倒序（原先靠 takeNewest 在截断时才排序，取消上限后必须显式排序）
  for (const post of [...posts].sort((a, b) => postTime(b.date) - postTime(a.date))) {
    const key = post.author || "_";
    const n = counts.get(key) || 0;
    if (n >= perAuthor) continue;
    counts.set(key, n + 1);
    out.push(post);
  }
  return out;
}
