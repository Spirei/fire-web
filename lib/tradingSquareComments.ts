/**
 * 交易广场 · 帖子评论。
 *
 * 段永平把雪球设成了「只有关注的人能评论」，所以他的帖子评论很少（实测最新 80 条里最多 4 条），
 * 但评论本身是正文之外唯一能看到别人观点的地方，值得一并搬到站内。
 *
 * 数据来自雪球 statuses/comments.json（需要配置里的雪球 Cookie），只取每条帖子的第一页，
 * 存成 data/duan-comments.json（按帖子 id 归档），刷新时按「评论数没变就跳过」省请求。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeTradingText } from "./tradingSquareText";
import { readJsonFile } from "./tradingSquareCache";
import { normalizeXueqiuAvatar } from "./tradingSquareImages";

const COMMENTS_FILE = path.join(process.cwd(), "data", "duan-comments.json");

export type XueqiuComment = {
  id?: number | string;
  created_at?: number | string;
  text?: string;
  like_count?: number;
  likes_count?: number;
  in_reply_to_comment_id?: number | string;
  user?: { id?: number | string; screen_name?: string; name?: string; profile_image_url?: string };
  [key: string]: unknown;
};

export type PostComment = {
  id: string;
  name: string;
  /** 评论者头像（本地化后的路径；拿不到就是原图地址，前端用首字母兜底） */
  avatar?: string;
  createdAt: string;
  text: string;
  likes?: number;
  /** 「回复@某人」里的那个人：评论楼中楼时用得上 */
  replyTo?: string;
};

/** 结构版本：头像地址解析方式变更时 +1，让旧缓存自动重抓一次（否则要等 TTL 过期） */
export const COMMENTS_CACHE_VERSION = 2;

export type PostComments = { updatedAt: string; total: number; comments: PostComment[]; version?: number };
export type CommentsCache = Record<string, PostComments>;

export function readDuanComments(): CommentsCache {
  return readJsonFile<CommentsCache>(COMMENTS_FILE, {});
}

export function writeDuanComments(value: CommentsCache): void {
  // 原子写交给调用方（tradingSquareRefresh 里统一走 writeJsonAtomic），这里只做存在性兜底
  fs.mkdirSync(path.dirname(COMMENTS_FILE), { recursive: true });
  fs.writeFileSync(COMMENTS_FILE, JSON.stringify(value));
}

export function commentsFilePath(): string {
  return COMMENTS_FILE;
}

/** 把雪球的评论转成站内结构（纯函数，便于回归测试）。 */
export function mapXueqiuComment(raw: XueqiuComment): PostComment | null {
  const id = raw?.id != null ? String(raw.id) : "";
  // 评论正文里同样会混进「回复@某人:」前缀：这里不丢掉它，而是拆成 replyTo，前端渲染成「回复 @某人」
  const text = normalizeTradingText(raw?.text || "", { keepReplyPrefix: true });
  const replyMatch = text.match(/^回复\s*@([^\s:：]{1,40})\s*[:：]\s*/u);
  const body = (replyMatch ? text.slice(replyMatch[0].length) : text).trim();
  if (!id || !body) return null;
  const user = raw.user || {};
  const name = String(user.screen_name || user.name || "").trim() || "雪球用户";
  const created = Number(raw.created_at);
  const likes = Number(raw.like_count ?? raw.likes_count ?? 0);
  return {
    id,
    name,
    ...(normalizeXueqiuAvatar(user.profile_image_url) ? { avatar: normalizeXueqiuAvatar(user.profile_image_url)! } : {}),
    createdAt: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : "",
    text: body,
    ...(Number.isFinite(likes) && likes > 0 ? { likes } : {}),
    ...(replyMatch?.[1] ? { replyTo: replyMatch[1] } : {})
  };
}
