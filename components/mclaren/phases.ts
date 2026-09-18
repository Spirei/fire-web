/**
 * 首页迈凯伦（F1 滚动叙事）的文案与锚点数据。
 * 这份数据不含 three.js 依赖，React 组件与 3D 场景都能直接引用，不会把 three 打进首屏包。
 */

export interface McLarenPhase {
  /** 进入该章节的滚动进度（0–1） */
  at: number;
  idx: string;
  name: string;
  /** 标题，按行拆分 */
  head: string[];
  /** 说明文字，按行拆分 */
  copy: string[];
  /** 中间按钮上方的说明 */
  cap: string;
}

export const MCL_PHASES: McLarenPhase[] = [
  { at: 0, idx: "01", name: "THE CAR", head: ["Built to chase", "the extraordinary."], copy: ["An obsession with every detail.", "A feeling like nothing else."], cap: "THE TRACK IS YOURS" },
  { at: 0.2, idx: "02", name: "AERO", head: ["Air, shaped", "to obey."], copy: ["Every surface earns its place.", "Downforce without compromise."], cap: "SCRUB THE APEX" },
  { at: 0.4, idx: "03", name: "POWER", head: ["Deploy.", "Then deploy again."], copy: ["1.6L V6 hybrid, eight gears,", "and one very loud idea."], cap: "LAUNCH IS ARMED" },
  { at: 0.58, idx: "04", name: "TYRES", head: ["Where the lap", "actually happens."], copy: ["Four patches of rubber carrying", "an entire team's work."], cap: "GRIP TO THE LIMIT" },
  { at: 0.78, idx: "05", name: "TECH", head: ["Two hundred sensors,", "one steering wheel."], copy: ["The car talks. The garage listens."], cap: "COOL DOWN" }
];

export interface McLarenPart {
  title: string;
  value: string;
  /** 部件锚点（世界坐标，车头朝 +Z） */
  pos: [number, number, number];
  /** 出现进度 */
  from: number;
  /** 标注放在锚点左侧 */
  rev: boolean;
}

export const MCL_PARTS: McLarenPart[] = [
  { title: "FRONT WING", value: "3-PLANE · OUTWASH", pos: [1.05, 0.24, 2.35], from: 0.24, rev: false },
  { title: "SIDEPOD", value: "PAPAYA · COOLING", pos: [1.1, 0.55, 0.5], from: 0.3, rev: false },
  { title: "REAR WING", value: "DRS · 2021 SPEC", pos: [-0.25, 1, -2.55], from: 0.36, rev: true },
  { title: "TYRES", value: "P ZERO · 18 IN", pos: [-1, 0.36, -1.35], from: 0.42, rev: true }
];
