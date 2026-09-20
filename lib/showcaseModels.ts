/**
 * 首页 3D 车型清单（服务端）。
 *
 * 车型素材一律手动导入：文件放在 uploads 卷的 public/uploads/mclaren/models/，
 * 参数写在同目录上一级的 showroom.json —— 两者都不进 Git、也不进镜像。
 *
 * 内置的四辆写在 components/showcase/presets/models.ts；这里负责把
 * 「内置 + 导入的」合成一份清单交给首页，并顺带标出文件缺失的车。
 */
import fs from "fs";
import path from "path";
import type { ShowcaseConfig, ShowcaseModelParams } from "@/components/showcase/types";
import { SHOWCASE_MODELS, buildImportedConfig } from "@/components/showcase/presets/models";

export const SHOWROOM_DIR = path.join(process.cwd(), "public", "uploads", "mclaren");
export const MODELS_DIR = path.join(SHOWROOM_DIR, "models");
export const COVERS_DIR = path.join(SHOWROOM_DIR, "covers");
const REGISTRY_FILE = path.join(SHOWROOM_DIR, "showroom.json");
const DRAFT_PREFIX = ".draft-";

export type { ShowcaseModelParams } from "@/components/showcase/types";

export interface StoredShowcaseModel {
  id: string;
  label: string;
  note: string;
  /** 文件名（不含路径），落在 MODELS_DIR 里 */
  file: string;
  /** 自定义封面（可选）：/uploads/mclaren/covers/xxx.jpg */
  cover?: string;
  params: ShowcaseModelParams;
  createdAt: string;
  updatedAt: string;
}

export interface ShowcaseModelOption {
  id: string;
  label: string;
  note: string;
  builtin: boolean;
  /** 素材文件当前是否在 uploads 卷里 */
  present: boolean;
  /** 自定义封面（没有就是空字符串，卡片用代号做占位） */
  cover: string;
  config: ShowcaseConfig;
}

const AXES = new Set(["x", "y", "z"]);

/**
 * uploads 卷里已有的三辆车的参数（原先写在 presets/models.ts 里）。
 * 登记表第一次生成时按文件名把它们补齐，之后一切以 showroom.json 为准 —— 用户可以在
 * 导入页里改参数，不再需要改代码。
 */
const KNOWN_FILES: Record<string, { id: string; label: string; note: string; params: ShowcaseModelParams }> = {
  "gulf_mclaren_f1_2022_car.glb": {
    id: "gulf2022",
    label: "Gulf F1",
    note: "2022",
    params: {
      length: 5.6,
      maxTextureSize: 2048,
      wheelPattern: "rims|tyres",
      wheelAxis: "x",
      wheelLateral: "x",
      wheelLongitudinal: "y",
      materialRules: [
        { match: "tyres|tyre", metalness: 0, roughness: 0.85 },
        { match: "rims", metalness: 1, roughness: 0.3 },
        { match: "carbon", metalness: 0.35, roughness: 0.45 }
      ]
    }
  },
  "mclaren_mp46.glb": {
    id: "mp46",
    label: "MP4/6",
    note: "1991",
    params: {
      length: 4.6,
      maxTextureSize: 2048,
      wheelPattern: "tyre",
      wheelAxis: "x",
      wheelLateral: "x",
      wheelLongitudinal: "z",
      materialRules: [
        { match: "tyre", metalness: 0, roughness: 0.85 },
        { match: "chrome", metalness: 1, roughness: 0.25 }
      ]
    }
  },
  "mclaren_mp45__formula_1.glb": {
    id: "mp45",
    label: "MP4/5",
    note: "1989",
    params: {
      length: 4.6,
      maxTextureSize: 2048,
      wheelPattern: "wheels",
      wheelAxis: "x",
      wheelLateral: "x",
      wheelLongitudinal: "z",
      materialRules: [{ match: "wheels", metalness: 0.2, roughness: 0.8 }]
    }
  }
};

/** 目录里现成的 .glb（手动 scp / docker cp 进去的也算），登记表没记的补一条默认参数 */
function discoverModelFiles(): string[] {
  try {
    // 网页上传先落为草稿；未保存的草稿一天后清理，不能被“手动放入目录”的自动发现提前上线。
    const now = Date.now();
    for (const name of fs.readdirSync(MODELS_DIR)) {
      if (!name.startsWith(DRAFT_PREFIX)) continue;
      try {
        const abs = path.join(MODELS_DIR, name);
        if (now - fs.statSync(abs).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(abs);
      } catch { /* 文件可能正被另一请求处理 */ }
    }
    return fs
      .readdirSync(MODELS_DIR)
      .filter((name) => validModelFile(name) && !isDraftModelFile(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 登记表兜底与自动发现：
 * - 首次部署（还没有 showroom.json）→ 按 uploads 卷里现有的 .glb 生成登记表；
 * - 之后用 scp / docker cp 直接往卷里丢 .glb 也能被认出来（默认参数，进导入页再调）；
 * - 只增不删：文件一时缺失（正在拷贝、临时改名）不会把参数弄丢。
 */
export function ensureRegistry() {
  const files = discoverModelFiles();
  const existed = fs.existsSync(REGISTRY_FILE);
  const registry = existed ? readRegistry() : { models: [], ignoredFiles: [] };
  const current = registry.models;
  const known = new Set(current.map((model) => model.file));
  const ignored = new Set(registry.ignoredFiles);
  const now = new Date().toISOString();
  const added: StoredShowcaseModel[] = files
    .filter((file) => !known.has(file) && !ignored.has(file))
    .map((file) => {
      const preset = KNOWN_FILES[file];
      return {
        id: preset?.id ?? file.replace(/\.glb$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40),
        label: preset?.label ?? file.replace(/\.glb$/i, "").slice(0, 24),
        note: preset?.note ?? "",
        file,
        params:
          preset?.params ?? { length: 5.6, maxTextureSize: 4096, wheelAxis: "x", wheelLateral: "x", wheelLongitudinal: "y" },
        createdAt: now,
        updatedAt: now
      };
    });
  if (!existed && !added.length) return [];
  if (!added.length) return current;
  // id 去重（两个文件名可能规整成同一个 id）
  const seen = new Set<string>();
  const models = [...current, ...added].filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  if (existed) {
    writeStoredModels(models);
  } else {
    // 首次生成登记表：内置车排在最前（之后一切以顺序表为准，拖到哪就是哪）
    writeStoredModels(models, [...SHOWCASE_MODELS.map((item) => item.id), ...models.map((model) => model.id)]);
  }
  return models;
}

/** 文件名安全校验：只允许一层、无路径穿越 */
export function validModelFile(name: string) {
  return /^[A-Za-z0-9._-]{1,120}\.glb$/.test(name) && !name.includes("..");
}

export function isDraftModelFile(name: string) {
  return name.startsWith(DRAFT_PREFIX) && validModelFile(name);
}

/** 上传接口使用：草稿能预览，但在“保存上线”之前不会进入自动发现清单。 */
export function draftModelFile(name: string) {
  const stem = name.replace(/\.glb$/i, "").slice(0, 86) || "model";
  return `${DRAFT_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}--${stem}.glb`;
}

export function validModelId(id: string) {
  return /^[a-z0-9][a-z0-9_-]{1,40}$/.test(id);
}

/** 把导入参数收敛成「只保留认识字段、数值合法」的形态，避免脏数据写进 registry */
export function sanitizeParams(input: unknown): ShowcaseModelParams {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: ShowcaseModelParams = {};
  const num = (key: keyof ShowcaseModelParams, min: number, max: number) => {
    const value = Number(raw[key as string]);
    if (Number.isFinite(value) && value >= min && value <= max) (out as Record<string, number>)[key as string] = value;
  };
  num("length", 1, 12);
  num("yaw", -360, 360);
  num("pitch", -180, 180);
  num("maxTextureSize", 256, 8192);
  num("emissiveIntensity", 0, 4);
  num("clearcoatRoughness", 0, 1);
  num("envMapIntensity", 0, 3);
  if (raw.wireframe && typeof raw.wireframe === "object") {
    const source = raw.wireframe as Record<string, unknown>;
    const wireframe: NonNullable<ShowcaseModelParams["wireframe"]> = {};
    const wireNum = (key: keyof typeof wireframe, min: number, max: number, integer = false) => {
      const value = Number(source[key]);
      if (Number.isFinite(value) && value >= min && value <= max) {
        (wireframe as Record<string, number>)[key] = integer ? Math.round(value) : value;
      }
    };
    if (typeof source.enabled === "boolean") wireframe.enabled = source.enabled;
    if (typeof source.filterThinTrim === "boolean") wireframe.filterThinTrim = source.filterThinTrim;
    wireNum("maxEdge", 0.03, 1);
    wireNum("maxDepth", 1, 3, true);
    wireNum("maxComponentTriangles", 10, 50_000, true);
    wireNum("triangleBudget", 10_000, 2_000_000, true);
    wireNum("trimMaxTriangles", 1, 1_000, true);
    wireNum("trimThickness", 0.001, 0.2);
    wireNum("trimWidth", 0.01, 1);
    wireNum("trimLength", 0.05, 2);
    out.wireframe = wireframe;
  }
  const axis = (key: "wheelAxis" | "wheelLateral" | "wheelLongitudinal") => {
    const value = String(raw[key] ?? "");
    if (AXES.has(value)) out[key] = value as "x" | "y" | "z";
  };
  axis("wheelAxis");
  axis("wheelLateral");
  axis("wheelLongitudinal");
  const validPattern = (value: string) => {
    try { new RegExp(value, "i"); return true; } catch { return false; }
  };
  if (typeof raw.wheelPattern === "string" && raw.wheelPattern.trim() && raw.wheelPattern.length <= 200 && validPattern(raw.wheelPattern.trim())) {
    out.wheelPattern = raw.wheelPattern.trim();
  }
  if (Array.isArray(raw.materialRules)) {
    const rules = raw.materialRules
      .slice(0, 40)
      .map((rule) => {
        const r = (rule ?? {}) as Record<string, unknown>;
        const match = typeof r.match === "string" ? r.match.trim().slice(0, 120) : "";
        if (!match || !validPattern(match)) return null;
        const item: { match: string; metalness?: number; roughness?: number } = { match };
        const metalness = Number(r.metalness);
        const roughness = Number(r.roughness);
        if (Number.isFinite(metalness)) item.metalness = Math.min(1, Math.max(0, metalness));
        if (Number.isFinite(roughness)) item.roughness = Math.min(1, Math.max(0, roughness));
        return item;
      })
      .filter((rule): rule is { match: string; metalness?: number; roughness?: number } => rule !== null);
    if (rules.length) out.materialRules = rules;
  }
  return out;
}

/** 登记表结构：车型数组 + 展示顺序（order 里是车型 id，首页车型条照它排） */
interface RegistryFile {
  version: number;
  order: string[];
  models: StoredShowcaseModel[];
  /** 内置车的少量可改项（素材在仓库里，参数写在代码里，目前只允许换封面） */
  builtinMeta?: Record<string, { cover?: string }>;
  /** 选择“移出清单但保留文件”的素材；自动发现必须跳过，否则刷新后会重新上线。 */
  ignoredFiles?: string[];
}

export function readRegistry(): {
  order: string[];
  models: StoredShowcaseModel[];
  builtinMeta: Record<string, { cover?: string }>;
  ignoredFiles: string[];
} {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Partial<RegistryFile>;
    const list = Array.isArray(raw.models) ? raw.models : [];
    const models = list.filter((item) => item && validModelId(item.id) && validModelFile(item.file));
    const order = (Array.isArray(raw.order) ? raw.order : []).filter((id) => typeof id === "string" && validModelId(id));
    const builtinMeta = raw.builtinMeta && typeof raw.builtinMeta === "object" ? raw.builtinMeta : {};
    const ignoredFiles = (Array.isArray(raw.ignoredFiles) ? raw.ignoredFiles : []).filter((file) => typeof file === "string" && validModelFile(file));
    return { order, models, builtinMeta, ignoredFiles };
  } catch {
    return { order: [], models: [], builtinMeta: {}, ignoredFiles: [] };
  }
}

export function readStoredModels(): StoredShowcaseModel[] {
  return readRegistry().models;
}

export function writeStoredModels(
  models: StoredShowcaseModel[],
  order?: string[],
  builtinMeta?: Record<string, { cover?: string }>,
  ignoredFiles?: string[]
) {
  fs.mkdirSync(SHOWROOM_DIR, { recursive: true });
  const tmp = `${REGISTRY_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const ids = models.map((model) => model.id);
  const previous = readRegistry();
  // 顺序表里不再存在的 id 丢掉；新加的车型补到末尾（保持「新导入的排在最后」）
  // 但内置车放在顺序表也可以（它不在这份 models 里），所以不过滤内置 id。
  const builtinIds = SHOWCASE_MODELS.map((item) => item.id);
  const usable = new Set([...ids, ...builtinIds]);
  const kept = (order ?? previous.order).filter((id) => usable.has(id));
  const finalOrder = [...kept, ...ids.filter((id) => !kept.includes(id))];
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: 1, order: finalOrder, models, builtinMeta: builtinMeta ?? previous.builtinMeta ?? {}, ignoredFiles: ignoredFiles ?? previous.ignoredFiles }, null, 2),
    "utf8"
  );
  fs.renameSync(tmp, REGISTRY_FILE);
}

/** 调整展示顺序（首页车型条按这个顺序排） */
export function saveModelOrder(ids: string[]): string[] {
  const { models } = readRegistry();
  // 内置车也在顺序表里（首页车型条与导入页共用同一份顺序），不能像以前那样被过滤掉 —— 
  // 过滤掉之后内置车会掉到顺序表之外、被排到最后
  const known = [...SHOWCASE_MODELS.map((item) => item.id), ...models.map((model) => model.id)];
  const seen = new Set<string>();
  const picked = ids.filter((id) => {
    if (seen.has(id) || !known.includes(id)) return false;
    seen.add(id);
    return true;
  });
  // 顺序表里没提到的车型：内置车补在最前（随仓库分发、开箱即用的那辆），其余按登记表原顺序补在末尾
  const rest = known.filter((id) => !seen.has(id));
  const order = [...picked, ...rest];
  writeStoredModels(models, order);
  return order;
}

/** /uploads/... 对应到 public 目录下的绝对路径（调用方负责确认它确实落在 uploads 内） */
function uploadsPath(url: string) {
  const root = path.join(process.cwd(), "public", "uploads");
  const abs = path.join(root, decodeURIComponent(url).replace(/^\/uploads\//, ""));
  // 登记表理论上只会有服务端生成的封面路径，但这里再兜一层：
  // 路径穿越（.. / 绝对路径）一律不认，避免被篡改的登记表删到 uploads 之外的文件
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!path.resolve(abs).startsWith(normalizedRoot)) throw new Error("封面路径不合法");
  return abs;
}

/** 删掉被替换 / 清空的封面文件（文件可能已被手动删掉，失败忽略） */
function removeUploadFile(url?: string) {
  if (!url || !url.startsWith("/uploads/")) return;
  try {
    fs.unlinkSync(uploadsPath(url));
  } catch {
    /* 旧封面可能已被删掉；路径不合法也走这里 */
  }
}

/**
 * 把「顺序表 + 登记表里现有的车型」补成一份完整顺序。
 *
 * 顺序表是唯一权威，但历史版本写下的顺序表可能缺项（老 bug：保存时把内置车的 id 过滤掉了），
 * 所以缺项的兜底是：内置车补在最前（随仓库分发、开箱即用的那辆），其余补在末尾。
 * 导入页与首页车型条都走这一个函数，两边不会排出两种顺序。
 */
export function resolveOrder(order: string[], modelIds: string[]): string[] {
  const builtinIds = SHOWCASE_MODELS.map((item) => item.id);
  const known = new Set([...builtinIds, ...modelIds]);
  const seen = new Set<string>();
  const kept = order.filter((id) => {
    if (seen.has(id) || !known.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...builtinIds.filter((id) => !seen.has(id)), ...kept, ...modelIds.filter((id) => !seen.has(id))];
}

/** 展示顺序的排序函数：顺序表里没有的（新导入 / 直接丢进卷里的）排到最后 */
export function orderRanker(order: string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return (id: string) => rank.get(id) ?? 999;
}

/** 更新单个车型的自定义封面（内置车的封面记在 builtinMeta，换封面时把旧文件删掉） */
export function setModelCover(id: string, cover: string): { id: string; cover: string } {
  const { models, order, builtinMeta } = readRegistry();
  // 内置车的素材在仓库里、参数写在代码里，但封面同样可以换成自己的照片
  if (SHOWCASE_MODELS.some((item) => item.id === id)) {
    const previous = builtinMeta[id]?.cover ?? "";
    const next = { ...builtinMeta, [id]: { ...(builtinMeta[id] ?? {}), cover } };
    if (!cover) delete next[id].cover;
    writeStoredModels(models, order, next);
    if (previous && previous !== cover) removeUploadFile(previous);
    return { id, cover };
  }
  const index = models.findIndex((model) => model.id === id);
  if (index < 0) throw new Error("车型不存在");
  const previous = models[index].cover;
  models[index] = { ...models[index], cover, updatedAt: new Date().toISOString() };
  writeStoredModels(models, order);
  if (previous && previous !== cover) removeUploadFile(previous);
  return { id, cover };
}

export function modelFileExists(file: string) {
  if (!validModelFile(file)) return false;
  try {
    return fs.statSync(path.join(MODELS_DIR, file)).isFile();
  } catch {
    return false;
  }
}

/** 模型素材是否真的在磁盘上：内置车在 public/mclaren/，导入车在 uploads 卷 models/ */
export function modelUrlExists(url: string) {
  const clean = decodeURIComponent(url.split("?")[0] ?? "");
  if (!clean.startsWith("/")) return true;
  const abs = path.join(process.cwd(), "public", clean);
  if (!abs.startsWith(path.join(process.cwd(), "public") + path.sep)) return false;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** 首页用的完整车型清单：按登记表里的展示顺序排（内置车也在顺序表里，可以拖到任意位置） */
export function listShowcaseOptions(): ShowcaseModelOption[] {
  // 先把登记表补齐（首次访问会新建），再读顺序 —— 否则第一次渲染拿不到 order 会排成另一个样子
  const stored = ensureRegistry();
  const { order, builtinMeta } = readRegistry();
  const builtin: ShowcaseModelOption[] = SHOWCASE_MODELS.map((item) => {
    const cover = builtinMeta[item.id]?.cover ?? "";
    return {
      id: item.id,
      label: item.label,
      note: item.note,
      builtin: true,
      present: modelUrlExists(item.config.assets.model),
      // 封面文件可能被手动删掉，取不到就回到车型代号占位
      cover: cover && modelUrlExists(cover) ? cover : "",
      config: item.config
    };
  });
  const imported: ShowcaseModelOption[] = stored
    .slice()
    .map((model) => ({
      id: model.id,
      label: model.label,
      note: model.note,
      builtin: false,
      present: modelFileExists(model.file),
      cover: model.cover && modelUrlExists(model.cover) ? model.cover : "",
      config: buildImportedConfig({ file: model.file, version: Date.parse(model.updatedAt) || 1, params: model.params })
    }));
  const all = [...builtin, ...imported];
  const rank = orderRanker(resolveOrder(order, stored.map((model) => model.id)));
  return all.sort((a, b) => rank(a.id) - rank(b.id));
}

/** 导入成功后写登记表（同 id 覆盖，方便重复导入同一辆车的新版本） */
export function upsertStoredModel(input: {
  id: string;
  label: string;
  note?: string;
  file: string;
  params?: ShowcaseModelParams;
}): StoredShowcaseModel {
  if (!validModelId(input.id)) throw new Error("车型代号只能用 a-z、0-9、-、_");
  if (SHOWCASE_MODELS.some((item) => item.id === input.id)) throw new Error("车型代号与内置车型重复，请换一个代号");
  if (!validModelFile(input.file)) throw new Error("素材文件名不合法");
  const label = input.label.trim().slice(0, 24);
  if (!label) throw new Error("请填写车型名称");
  let file = input.file;
  if (isDraftModelFile(file)) {
    const original = file.split("--").slice(1).join("--") || "model.glb";
    const stem = original.replace(/\.glb$/i, "").slice(0, 86) || "model";
    let finalName = `${stem}.glb`;
    let serial = 1;
    while (modelFileExists(finalName)) finalName = `${stem}-${serial++}.glb`;
    fs.renameSync(path.join(MODELS_DIR, file), path.join(MODELS_DIR, finalName));
    file = finalName;
  }
  if (!modelFileExists(file)) throw new Error("素材文件不在 uploads 卷里，请重新上传");
  const now = new Date().toISOString();
  const models = ensureRegistry();
  const index = models.findIndex((item) => item.id === input.id);
  const previousFile = index >= 0 ? models[index].file : undefined;
  const entry: StoredShowcaseModel = {
    id: input.id,
    label,
    note: (input.note ?? "").trim().slice(0, 24),
    file,
    params: sanitizeParams(input.params ?? {}),
    createdAt: index >= 0 ? models[index].createdAt : now,
    updatedAt: now
  };
  if (index >= 0) models[index] = entry;
  else models.push(entry);
  writeStoredModels(models);
  if (previousFile && previousFile !== file && !models.some((item, i) => i !== index && item.file === previousFile)) {
    try { fs.unlinkSync(path.join(MODELS_DIR, previousFile)); } catch { /* 旧文件可能已手动移走 */ }
  }
  return entry;
}

export function removeStoredModel(id: string, options: { deleteFile?: boolean } = {}) {
  const models = ensureRegistry();
  const registry = readRegistry();
  const entry = models.find((item) => item.id === id);
  if (!entry) throw new Error("车型不存在");
  const ignoredFiles = options.deleteFile
    ? registry.ignoredFiles.filter((file) => file !== entry.file)
    : [...new Set([...registry.ignoredFiles, entry.file])];
  writeStoredModels(models.filter((item) => item.id !== id), undefined, undefined, ignoredFiles);
  if (options.deleteFile) {
    try {
      fs.unlinkSync(path.join(MODELS_DIR, entry.file));
    } catch {
      /* 文件可能已经被手动删掉 */
    }
  }
  return entry;
}
