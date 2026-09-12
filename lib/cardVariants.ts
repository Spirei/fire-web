/**
 * 同一张卡的新卡面 / 旧卡面（含上游重复素材）。
 *
 * 素材库直接镜像上游 GitHub 目录：上游会把「同一张卡的另一版卡面」另存成 `(新)` / `(Old)`
 * 或同名不同扩展名，于是同一张卡在卡面库里出现两三次。这里把它们并成一条：
 *   - primary：列表与卡包里展示的那张（新卡面；同图不同格式时留清晰度更高的）
 *   - faces：详情页里可以翻看的其它卡面（新 → 旧）
 *   - drop：与另一张完全重复、直接不显示的素材
 * 键都是清单里的 card file（URL 编码后的相对路径），与 holdings / amounts / 标签的 key 一致。
 *
 * 将来要合并新的：按「同银行 + 去掉 新/旧/Old/New 等标记后同名」扫一遍全库，再加一条即可。
 */
export interface CardFace {
  file: string;
  label: string;
}

export interface CardVariantGroup {
  primary: string;
  faces: CardFace[];
  drop: string[];
}

export const CARD_VARIANT_GROUPS: CardVariantGroup[] = [
  {
    primary: "%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E5%80%9F%E8%AE%B0%E5%8D%A1/%E4%B8%AD%E5%9C%8B%E9%8A%80%E8%A1%8C%20(%E9%A6%99%E6%B8%AF)/%E4%B8%AD%E9%8A%80%E5%8D%A1.png",
    faces: [{ file: "%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E5%80%9F%E8%AE%B0%E5%8D%A1/%E4%B8%AD%E5%9C%8B%E9%8A%80%E8%A1%8C%20(%E9%A6%99%E6%B8%AF)/%E4%B8%AD%E9%8A%80%E5%8D%A1.jpg", label: "旧卡面" }],
    // 「中銀卡（舊）.jpg」与上面那张旧卡面字节完全相同（上游重复收录），直接不显示
    drop: ["%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E5%80%9F%E8%AE%B0%E5%8D%A1/%E4%B8%AD%E5%9C%8B%E9%8A%80%E8%A1%8C%20(%E9%A6%99%E6%B8%AF)/%E4%B8%AD%E9%8A%80%E5%8D%A1%EF%BC%88%E8%88%8A%EF%BC%89.jpg"]
  },
  {
    primary: "%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E5%80%9F%E8%AE%B0%E5%8D%A1/%E9%A6%99%E6%B8%AF%E4%B8%8A%E6%B5%B7%E6%BB%99%E8%B1%90%E9%8A%80%E8%A1%8C/HSBC%20Mastercard%20Debit%20%E6%BB%99%E8%B1%90%E8%90%AC%E4%BA%8B%E9%81%94%E5%8D%A1%E6%89%A3%E8%B3%AC%E5%8D%A1%20(%E6%96%B0).png",
    faces: [{ file: "%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E5%80%9F%E8%AE%B0%E5%8D%A1/%E9%A6%99%E6%B8%AF%E4%B8%8A%E6%B5%B7%E6%BB%99%E8%B1%90%E9%8A%80%E8%A1%8C/HSBC%20Mastercard%20Debit%20%E6%BB%99%E8%B1%90%E8%90%AC%E4%BA%8B%E9%81%94%E5%8D%A1%E6%89%A3%E8%B3%AC%E5%8D%A1.png", label: "旧卡面" }],
    drop: []
  },
  {
    primary: "%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E4%BF%A1%E7%94%A8%E5%8D%A1/%E9%A6%99%E6%B8%AF%E4%B8%8A%E6%B5%B7%E6%BB%99%E8%B1%90%E9%8A%80%E8%A1%8C/HSBC%20Premier%20MasterCard%20%E6%BB%99%E8%B1%90%E5%8D%93%E8%B6%8A%E7%90%86%E8%B2%A1%E4%BF%A1%E7%94%A8%E5%8D%A1.png",
    faces: [{ file: "%E4%B8%AD%E5%9B%BD%E9%A6%99%E6%B8%AF/%E4%BF%A1%E7%94%A8%E5%8D%A1/%E9%A6%99%E6%B8%AF%E4%B8%8A%E6%B5%B7%E6%BB%99%E8%B1%90%E9%8A%80%E8%A1%8C/HSBC%20Premier%20MasterCard%20%E6%BB%99%E8%B1%90%E5%8D%93%E8%B6%8A%E7%90%86%E8%B2%A1%E4%BF%A1%E7%94%A8%E5%8D%A1%20(Old).png", label: "旧卡面" }],
    drop: []
  },
  {
    primary: "%E5%8A%A0%E6%8B%BF%E5%A4%A7/%E4%BF%A1%E7%94%A8%E5%8D%A1/HSBC%20Bank%20(Canada)/HSBC%20Canada%20World%20Elite%20Mastercard.png",
    faces: [{ file: "%E5%8A%A0%E6%8B%BF%E5%A4%A7/%E4%BF%A1%E7%94%A8%E5%8D%A1/HSBC%20Bank%20(Canada)/HSBC%20Canada%20World%20Elite%20Mastercard%20(Old).jpg", label: "旧卡面" }],
    drop: []
  },
  {
    primary: "%E8%8B%B1%E5%9B%BD/%E5%80%9F%E8%AE%B0%E5%8D%A1/Chase%20UK/Chase%20Debit%20Card.png",
    faces: [],
    drop: ["%E8%8B%B1%E5%9B%BD/%E5%80%9F%E8%AE%B0%E5%8D%A1/Chase%20UK/Chase%20Debit%20Card.jpg"]
  }
];

/** 被合并掉的（不显示的）素材文件 */
export const CARD_VARIANT_DROPPED = new Set(CARD_VARIANT_GROUPS.flatMap((group) => group.drop));

/**
 * 列表里不再单独出现的卡面文件：被合并掉的重复素材 + 已经并进主卡的旧卡面
 * （旧卡面本身还在，只是改成在详情页翻面看，不再占一条卡片）。
 */
export const CARD_VARIANT_MERGED = new Set<string>([
  ...CARD_VARIANT_DROPPED,
  ...CARD_VARIANT_GROUPS.flatMap((group) => group.faces.map((face) => face.file))
]);

/** 主卡 → 它可以翻看的其它卡面 */
export const CARD_VARIANT_FACES: Record<string, CardFace[]> = Object.fromEntries(
  CARD_VARIANT_GROUPS.filter((group) => group.faces.length > 0).map((group) => [group.primary, group.faces])
);

/**
 * 主卡 → 这一组里所有「可能记着持有 / 金额 / 标签」的 key（主卡 + 其它卡面 + 被去重的重复素材）。
 * 合并后取第一个有数据的当数据键，避免本来记在旧卡面或重复素材上的数据变成"未加入我的卡"。
 */
export const CARD_VARIANT_MERGE_KEYS: Record<string, string[]> = Object.fromEntries(
  CARD_VARIANT_GROUPS.map((group) => [
    group.primary,
    [group.primary, ...group.faces.map((face) => face.file), ...group.drop]
  ])
);
