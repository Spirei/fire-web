const DEFAULT_FLAG_OVERRIDES: Record<string, string> = {
  eu: "/uploads/asset/flag/欧盟EU.svg"
};

/** 返回随源码 / Docker 镜像发布的默认国旗路径。 */
export function defaultFlagUrl(code: string): string {
  const normalized = code.trim().toLowerCase();
  return DEFAULT_FLAG_OVERRIDES[normalized] || `/uploads/asset/flag/${normalized}.svg`;
}
