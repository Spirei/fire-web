/**
 * 卡面素材（素材库 → 「卡片」类目）。
 *
 * 卡面原来是清单（`public/uploads/cards/manifest.json`）里的文件，只能在卡面库看；
 * 现在每张卡都在 `assets` 里登记一条 `type = "card"` 的素材，于是素材库能像管理
 * 其他图标一样统一管理卡面（上传 / 替换 / 删除），并且卡面库与卡包读的就是这条素材的
 * `url` —— 在素材库换一张图，卡面库立刻跟着变，不会出现「两处各管一份」。
 *
 * 本文件不引入任何服务端依赖，客户端拼 id 也能用。
 */

/** 素材库 id 约定：`card:{卡面文件路径}`（cardKey 即清单里的 file，大小写敏感，不要规范化） */
export function cardAssetId(cardKey: string): string {
  return `card:${cardKey}`;
}

/** 从素材库 id 还原卡面文件路径（不是卡片素材时返回 null） */
export function cardKeyOfAssetId(id: string): string | null {
  return id.startsWith("card:") ? id.slice(5) : null;
}

/** 清单原图地址 */
export function manifestCoverUrl(cardKey: string): string {
  return `/uploads/cards/${cardKey}`;
}
