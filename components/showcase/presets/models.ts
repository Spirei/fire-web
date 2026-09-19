/**
 * 首页可切换的车型清单。
 *
 * 每辆车就是一份 ShowcaseConfig：素材路径 + 车型参数（长度 / 朝向修正 / 轮子材质名）覆盖，
 * 镜头、隧道、地面、后期这些与车型无关的部分直接复用 MCL35M 那一套。
 * 加车 = 把 glb 放进 public/mclaren/，在这里加一条（必要时按渲染结果微调 model.yaw / pitch）。
 */
import type { ShowcaseConfig } from "../types";
import { MCL35M_SHOWCASE } from "./mcl35m";

/** 2022 赛季 Gulf 涂装（海湾石油配色） */
export const GULF2022_SHOWCASE: ShowcaseConfig = {
  ...MCL35M_SHOWCASE,
  assets: { ...MCL35M_SHOWCASE.assets, model: "/mclaren/gulf_mclaren_f1_2022_car.glb?v=1" },
  model: {
    ...MCL35M_SHOWCASE.model,
    length: 5.6,
    // 这辆车带 8192×8192 贴图（解码后接近 270 MB 显存），按 2048 收起
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
};

/** 1991 MP4/6：经典的红白涂装 */
export const MP46_SHOWCASE: ShowcaseConfig = {
  ...MCL35M_SHOWCASE,
  assets: { ...MCL35M_SHOWCASE.assets, model: "/mclaren/mclaren_mp46.glb?v=1" },
  model: {
    ...MCL35M_SHOWCASE.model,
    length: 4.6,
    wheelPattern: "tyre",
    wheelAxis: "x",
    wheelLateral: "x",
    wheelLongitudinal: "z",
    maxTextureSize: 2048,
    materialRules: [
      { match: "tyre", metalness: 0, roughness: 0.85 },
      { match: "chrome", metalness: 1, roughness: 0.25 }
    ]
  }
};

/** 1989 MP4/5：塞纳座驾，模型体积超过 GitHub 单文件上限，放在 uploads 卷里（不进仓库） */
export const MP45_SHOWCASE: ShowcaseConfig = {
  ...MCL35M_SHOWCASE,
  assets: { ...MCL35M_SHOWCASE.assets, model: "/uploads/mclaren/models/mclaren_mp45__formula_1.glb" },
  model: {
    ...MCL35M_SHOWCASE.model,
    length: 4.6,
    wheelPattern: "wheels",
    wheelAxis: "x",
    wheelLateral: "x",
    wheelLongitudinal: "z",
    maxTextureSize: 2048,
    materialRules: [{ match: "wheels", metalness: 0.2, roughness: 0.8 }]
  }
};

export interface ShowcaseModelOption {
  id: string;
  /** 卡片上的车型代号，例如 MCL35M */
  label: string;
  /** 一行小字，例如年份 / 说明 */
  note: string;
  config: ShowcaseConfig;
}

export const SHOWCASE_MODELS: ShowcaseModelOption[] = [
  { id: "mcl35m", label: "MCL35M", note: "2021", config: MCL35M_SHOWCASE },
  { id: "gulf2022", label: "Gulf F1", note: "2022", config: GULF2022_SHOWCASE },
  { id: "mp46", label: "MP4/6", note: "1991", config: MP46_SHOWCASE },
  { id: "mp45", label: "MP4/5", note: "1989", config: MP45_SHOWCASE }
];

export const DEFAULT_SHOWCASE_MODEL = SHOWCASE_MODELS[0].id;
