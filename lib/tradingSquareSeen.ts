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
