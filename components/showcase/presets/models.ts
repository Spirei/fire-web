/**
 * 首页可切换的车型清单。
 *
 * 每辆车就是一份 ShowcaseConfig：素材路径 + 车型参数（长度 / 朝向修正 / 轮子材质名）覆盖，
 * 镜头、隧道、地面、后期这些与车型无关的部分直接复用 MCL35M 那一套。
 *
 * 下面四辆是内置车型，素材放在 uploads 卷（public/uploads/mclaren/models/，不进 Git 也不进镜像）。
 * 之后再进新车不用改这个文件：首页右下角车型条的「＋」走导入流程，参数写进 uploads 卷里的
 * showroom.json，由 lib/showcaseModels.ts 读出来合并到这份清单后面（见 docs/showcase-3d.md）。
 */
import type { ShowcaseConfig, ShowcaseModelParams } from "../types";
import { MCL35M_SHOWCASE } from "./mcl35m";

export interface ShowcaseModelOption {
  id: string;
  /** 卡片上的车型代号，例如 MCL35M */
  label: string;
  /** 一行小字，例如年份 / 说明 */
  note: string;
  config: ShowcaseConfig;
}

export const SHOWCASE_MODELS: ShowcaseModelOption[] = [
  // 只有这一辆随仓库分发（别人克隆 / 部署后开箱就有车可看）。
  // 其余车型全部走「导入」：文件放 uploads 卷、参数写 showroom.json，见 lib/showcaseModels.ts
  { id: "mcl35m", label: "MCL35M", note: "2021", config: MCL35M_SHOWCASE }
];

export const DEFAULT_SHOWCASE_MODEL = SHOWCASE_MODELS[0].id;

/**
 * 把「手动导入的车型」参数套到内置预设上，得到可直接交给引擎的配置。
 *
 * 镜头、隧道、地面、后期全部复用 MCL35M 那一套（本来就是车型无关的），
 * 只有素材路径与 model 下的那几个参数用导入值覆盖 —— 服务端写登记表与浏览器里的
 * 导入预览都走这一个函数，避免两边算出来的配置不一致。
 */
export function buildImportedConfig(input: {
  file: string;
  version?: string | number;
  params?: ShowcaseModelParams;
}): ShowcaseConfig {
  const version = input.version ?? 1;
  // 已保存的旧车型还没有 topKmh 字段，按已知车型给一次兼容默认值；
  // 用户在导入页设置后始终以自己保存的参数为准。
  const legacyTopKmh = input.file === "gulf_mclaren_f1_2022_car.glb" ? 350
    : input.file === "mclaren_mp46.glb" ? 335 : MCL35M_SHOWCASE.speed.topKmh;
  return {
    ...MCL35M_SHOWCASE,
    speed: { ...MCL35M_SHOWCASE.speed, topKmh: input.params?.topKmh ?? legacyTopKmh },
    assets: {
      ...MCL35M_SHOWCASE.assets,
      model: `/uploads/mclaren/models/${encodeURIComponent(input.file)}?v=${version}`
    },
    model: { ...MCL35M_SHOWCASE.model, ...(input.params ?? {}) }
  };
}
