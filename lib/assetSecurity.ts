import path from "node:path";

export function validAssetCode(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9._:-]{0,39}$/.test(value) && !value.includes("..");
}

export function assetFilePath(root: string, filename: string): string {
  if (filename !== path.basename(filename) || /[\\/\0]/.test(filename)) throw new Error("无效的素材文件名");
  const target = path.resolve(root, filename);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("素材路径越界");
  return target;
}
