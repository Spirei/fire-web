const DEFAULT_FLAG_OVERRIDES: Record<string, string> = {
  eu: "/uploads/asset/flag/欧盟EU.svg"
};

/** 全站固定的 7 种展示货币；资金系统的扩展币种在实际出现时再按代码读取。 */
export const CURRENCY_FLAG_CODES = ["US", "EU", "HK", "CN", "JP", "KR", "SG"] as const;

/** 返回随源码 / Docker 镜像发布的默认国旗路径。 */
export function defaultFlagUrl(code: string): string {
  const normalized = code.trim().toLowerCase();
  return DEFAULT_FLAG_OVERRIDES[normalized] || `/uploads/asset/flag/${normalized}.svg`;
}
