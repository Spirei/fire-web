/** 列表接口与浏览器缓存只保留最近 N 条，避免段永平全量时间线把页面撑爆。 */
export const TRADING_SQUARE_FEED_LIMIT = 200;
/** 段永平本地 JSON 缓存上限（按时间新到旧）。 */
export const DUAN_CACHE_LIMIT = 200;

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
