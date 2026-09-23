import type { ShowcaseModelParams } from "./types";

export function wheelSelectionPattern(names: string[]) {
  // 空选择必须显式禁用匹配，undefined 会让引擎退回默认轮胎规则。
  return names.length ? `^(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$` : "(?!)";
}

export function matchingWheelMaterials(names: string[], pattern?: string) {
  if (!pattern) return [];
  try { const regex = new RegExp(pattern, "i"); return names.filter(name => regex.test(name)); }
  catch { return []; }
}

export function suggestWheelMaterials(names: string[]) {
  return names.filter(name => /wheel|tyre|tire|rim/i.test(name) && !/steer|st_wheel|wing|windlet|suspension|brake|caliper/i.test(name));
}

export function validateWorkbench(meta: { id: string; label: string; note: string }, params: ShowcaseModelParams) {
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(meta.id)) return "车型代号需为 2–40 位英文小写、数字、- 或 _";
  if (!meta.label.trim() || meta.label.length > 24) return "车型名称需为 1–24 个字符";
  if (meta.note.length > 24) return "年份 / 说明不能超过 24 个字符";
  if (params.wheelPattern && params.wheelPattern.length > 200) return "轮子材质选择过多，请缩减选择后保存";
  const ranges: Array<[keyof ShowcaseModelParams, number, number, string]> = [
    ["length", 1, 12, "车长"], ["topKmh", 100, 500, "最高时速"], ["yaw", -360, 360, "朝向修正"], ["pitch", -180, 180, "上下修正"],
    ["maxTextureSize", 256, 8192, "贴图上限"], ["emissiveIntensity", 0, 4, "发光强度"], ["clearcoatRoughness", 0, 1, "清漆粗糙度"]
  ];
  for (const [key, min, max, label] of ranges) {
    const value = params[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) return `${label}需在 ${min}–${max} 之间`;
  }
  if ((params.wheelLateral ?? "x") === (params.wheelLongitudinal ?? "y")) return "左右轴与前后轴不能选择同一根轴";
  return null;
}
