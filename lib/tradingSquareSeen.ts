/**
 * 交易广场的「新动态」判断（纯函数，便于回归测试）。
 *
 * seen 存的是每位作者上次看到的时间戳（localStorage `fire:trading-square-seen`）：
 * 比它新的帖子就是「新动态」—— 作者卡片上的未读计数和帖子上的「新」角标共用同一套判断，
 * 保证两处永远一致。
 */

export type SeenTimes = Record<string, string | null | undefined>;
export type SeenPost = { author: string; date: string };

function seenAt(seen: SeenTimes, author: string) {
  const parsed = Date.parse(seen[author] || "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** 这条帖子对当前用户来说是不是新的。 */
export function isUnseenPost(post: SeenPost, seen: SeenTimes): boolean {
  const time = Date.parse(post.date);
  if (!Number.isFinite(time)) return false;
  const at = seenAt(seen, post.author);
  return at === null || time > at;
}

/** 每位作者各有多少条新动态。 */
export function unseenCounts(posts: SeenPost[], seen: SeenTimes): Record<string, number> {
  const counts: Record<string, number> = {};
  posts.forEach((post) => {
    if (!isUnseenPost(post, seen)) return;
    counts[post.author] = (counts[post.author] || 0) + 1;
  });
  return counts;
}

/**
 * 「新动态」与「看过的帖子」之间的分界下标（-1 = 这一页里没有分界，不画线）。
 *
 * 列表按时间倒序，新动态在最上面，所以分界画在最后一条新动态下面：
 * 整页都是新动态（第一次打开）时没有分界，看完之后再进来也不会凭空多一条线。
 */
export function unseenBoundaryIndex(posts: SeenPost[], seen: SeenTimes): number {
  let boundary = -1;
  posts.forEach((post, index) => {
    const next = posts[index + 1];
    if (next && isUnseenPost(post, seen) && !isUnseenPost(next, seen)) boundary = index;
  });
  return boundary;
}
