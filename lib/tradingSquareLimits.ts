/**
 * 列表接口的每位作者条数上限。
 * 2026-09-11 按要求取消限制：接口返回该作者的全部历史（磁盘缓存本就是完整历史，不丢数据）。
 * 注意：无上限后 payload 与客户端 localStorage 缓存会随历史增长；将来若出现缓存写入失败，
 * 可以在「客户端缓存」这一层单独截断，不影响列表展示。
 */
export const TRADING_SQUARE_AUTHOR_LIMIT = Number.POSITIVE_INFINITY;

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
