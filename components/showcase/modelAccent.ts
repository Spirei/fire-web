/** 取车身涂装里醒目的颜色作刻度选中态；中性黑白不适合在深浅主题间作指示色。 */
export function modelAccent(modelAsset: string): string {
  const file = decodeURIComponent(modelAsset.split("?")[0]).toLowerCase();
  if (file.includes("gulf")) return "#1887a8";
  if (file.includes("mp45") || file.includes("mp4-5")) return "#dc4438";
  if (file.includes("mp46") || file.includes("mp4-6")) return "#dc4438";
  if (file.includes("amr26") || file.includes("amr23") || file.includes("aston-martin")) return "#16816e";
  // MCL35M / MCL39 均以木瓜橙为主；未知导入车沿用站点的橙色。
  return "#ed790b";
}
