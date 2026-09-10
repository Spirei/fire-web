/**
 * ⚠️ 仅「收益曲线前后对比」页（/curve-compare）使用 —— ef550b6 版旧口径的复刻。
 *
 * 存在的唯一目的：把「改动前」的真实算法拿真实账户数据跑一遍，和现在并排看差异。
 * **业务代码禁止 import 本文件**：全站曲线口径只有 lib/curve.ts 一份（见 AGENTS.md）。
 * 曲线数值算法（Modified Dietz / 累计收益）两版逐值一致，因此这里复用 ledgerSeries；
 * 差异在窗口边界与基准对齐上 —— 也正是这个文件要复刻的两件事：
 *   1) 周期窗口用 setMonth 回退（不做月末夹取）+ 用「时间戳」比较日期（受当前时刻影响）；
 *   2) 基准只取窗口内的点，且按「自己的点数」均分到整张图（等于时间轴错位）。
 */
import {
  buildCurveSpec,
  dayOf,
  ledgerSeries,
  normalizeToPercent,
  type CurveBenchRow,
  type CurveLedgerRow,
  type CurveMarkerSpec,
  type CurveRange,
  type CurveSeriesSpec,
  type CurveSpec,
  type LedgerCurveKind
} from "./curve";

function sorted<T extends { d: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => String(a.d).localeCompare(String(b.d)));
}

/** 旧版周期窗口（逐行复刻 ef550b6 的 filterHist，range = future/custom 在对比页用不到） */
export function legacyWindow<T extends { d: string }>(rows: T[], range: CurveRange, now: Date = new Date()): T[] {
  const all = sorted(rows);
  const since = (cut: number) => {
    const inside = all.filter((row) => dayOf(row.d) >= cut);
    const before = all.filter((row) => dayOf(row.d) < cut);
    return before.length ? [before[before.length - 1], ...inside] : inside;
  };
  if (range === "month") return since(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
  if (range === "1m" || range === "6m") {
    const cut = new Date(now);
    cut.setMonth(now.getMonth() - (range === "1m" ? 1 : 6));
    return since(cut.getTime());
  }
  if (range === "ytd") return since(new Date(now.getFullYear(), 0, 1).getTime());
  if (range === "1y") {
    const cut = new Date(now);
    cut.setFullYear(now.getFullYear() - 1);
    return since(cut.getTime());
  }
  return all;
}

/** 旧版基准线：窗口内裁剪 → 按自己的首值归一化（点数与组合日期轴无关） */
export function legacyBenchSeries(rows: CurveBenchRow[], range: CurveRange, window: Array<{ d: string }>, now: Date = new Date()): number[] {
  const benchRows = legacyWindow(rows.map((row) => ({ d: row.d, v: row.c })), range, now)
    .filter((row) => (!window[0] || row.d >= window[0].d) && (!window.length || row.d <= window[window.length - 1].d));
  return benchRows.length ? normalizeToPercent(benchRows.map((row) => row.v)) : [];
}

/** 把 N 个点按索引线性重采样成 count 个点（旧图把基准铺满整张图，等价于这个变换） */
export function stretchToCount(values: number[], count: number): number[] {
  if (!values.length || count <= 0) return [];
  if (values.length === 1 || count === 1) return new Array(count).fill(values[0]);
  return Array.from({ length: count }, (_, index) => {
    const position = ((values.length - 1) * index) / (count - 1);
    const low = Math.floor(position);
    const high = Math.min(values.length - 1, low + 1);
    return values[low] + (values[high] - values[low]) * (position - low);
  });
}

export interface LegacyCurveInput {
  rows: CurveLedgerRow[];
  range: CurveRange;
  kind: LedgerCurveKind;
  /** 旧实现当时看到的「现在」——换时刻能看出窗口会漂 */
  now?: Date;
  benchmark?: { rows: CurveBenchRow[]; label: string } | null;
  expectedRate?: number | null;
  alignEndValue?: number | null;
  unit?: string;
}

/** 旧版（ef550b6）账本 → 曲线规格，交给同一套 SVG 适配器渲染，保证只有口径不同 */
export function legacyCurveSpec(input: LegacyCurveInput): CurveSpec {
  const now = input.now ?? new Date();
  const list = legacyWindow(input.rows, input.range, now);
  const series = ledgerSeries(list, input.kind);
  let mainValues = series.values;
  if (input.kind === "pnl" && mainValues.length && Number.isFinite(Number(input.alignEndValue))) {
    const delta = Number(input.alignEndValue) - mainValues[mainValues.length - 1];
    mainValues = mainValues.map((value) => value + delta);
  }
  const spec: CurveSeriesSpec[] = [{
    key: "main",
    label: input.kind === "pnl" ? "累计收益" : "资金加权收益率",
    role: "main",
    format: input.kind === "pnl" ? "amount" : "percent",
    values: mainValues
  }];
  if (input.kind === "mwr" && input.benchmark?.rows.length && series.dates.length) {
    spec.push({
      key: "bench",
      label: input.benchmark.label,
      role: "bench",
      format: "percent",
      // 旧实现的蓝线按自身点数铺满整张图 —— 重采样后交给同一位位置映射即可还原
      values: stretchToCount(legacyBenchSeries(input.benchmark.rows, input.range, list, now), series.dates.length)
    });
  }
  const markers: CurveMarkerSpec[] = [{ kind: "zero", value: 0 }];
  if (input.kind === "mwr" && input.expectedRate && list.length >= 2) {
    const years = Math.max(0.05, (dayOf(list[list.length - 1].d) - dayOf(list[0].d)) / 365 / 86400000);
    markers.push({ kind: "expected", value: Number(input.expectedRate) * years });
  }
  return buildCurveSpec({
    dates: series.dates,
    series: spec,
    markers,
    unit: input.unit,
    // 旧实现没有命中点抽稀：每个数据点都渲染一个圆
    hitTarget: Number.MAX_SAFE_INTEGER,
    kind: input.kind,
    range: input.range,
    windowStart: list.length ? String(list[0].d) : undefined,
    windowEnd: list.length ? String(list[list.length - 1].d) : undefined
  });
}
