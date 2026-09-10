/**
 * 交易广场列表口径（服务端与客户端共用）
 *
 * 2026-09-11 定案：以「现有内容 + 往后追加新帖」为准 —— 不设时间窗、不截断历史，
 * 段永平与特朗普一视同仁；客户端首屏缓存另有单独收敛（见 components/views/TradingSquareView.tsx）。
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
