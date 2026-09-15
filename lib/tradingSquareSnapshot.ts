import { postTimestamp, readDuanPosts, readTrumpPosts, withoutRemoteImages } from "./tradingSquareRefresh";
import { readTranslations, validTranslation } from "./tradingSquareTranslate";
import { hasTranslatableText } from "./tradingSquareText";
import { takeNewestByAuthor } from "./tradingSquareLimits";

export type TradingSquareSnapshotPost = {
  id: string;
  author: "trump" | "duan";
  date: string;
  text: string;
  textZh?: string;
  originalUrl: string;
  categories?: Array<"hot" | "original" | "longform">;
  quote?: { name: string; text: string; url?: string; images?: string[] };
  images?: string[];
};

/**
 * 交易广场首屏快照：与 /api/trading-square/feed 同源的**只读**组装（不触发任何抓取、
 * 不动缓存文件），让刷新时先用服务端已有内容画出列表与作者头像，再等接口返回最新数据。
 * 与接口一样只保留本地化后的图片地址，避免首屏引用会失效的远端图。
 */
export function readTradingSquareSnapshot(perAuthor: number): TradingSquareSnapshotPost[] {
  const translations = readTranslations();
  const trump: TradingSquareSnapshotPost[] = readTrumpPosts().map((post) => {
    const textZh = hasTranslatableText(post.text) && validTranslation(translations[post.id]) ? translations[post.id] : undefined;
    return withoutRemoteImages(textZh ? { ...post, textZh, author: "trump" as const } : { ...post, author: "trump" as const });
  });
  const duan: TradingSquareSnapshotPost[] = readDuanPosts().map((post) => withoutRemoteImages({ ...post, author: "duan" as const }));
  const merged = [...trump, ...duan].sort((a, b) => postTimestamp(b.date) - postTimestamp(a.date));
  return takeNewestByAuthor(merged, perAuthor);
}
