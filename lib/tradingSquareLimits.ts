/** 列表接口每位作者最多返回最近 N 条；磁盘缓存仍保留完整历史供翻页重叠。 */
export const TRADING_SQUARE_AUTHOR_LIMIT = 200;

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
  for (const post of takeNewest(posts, posts.length)) {
    const key = post.author || "_";
    const n = counts.get(key) || 0;
    if (n >= perAuthor) continue;
    counts.set(key, n + 1);
    out.push(post);
  }
  return out;
}
