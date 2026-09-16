/**
 * 持仓盈亏桑基图的排版参数（纯函数，便于回归测试）。
 *
 * 此前只有「宽屏 / 窄屏」两套写死的值（左右边距固定 82 或 170、标签固定两行）：
 * 手机 366px 的画布上，两端各 82px 的空白吃掉 45% 宽度，中间只剩 ~190px 画画，
 * 流带被挤成两道竖帘；两行标签行高 12px 又小又高，ECharts 的 hideOverlap 干脆把
 * 「英特尔」「小鹏汽车」这类小持仓的标签整个隐藏 —— 表现就是「没有自适配、被拉宽」。
 *
 * 现在改为按可用宽度连续计算：标签列宽、边距、字号、节点宽度都随宽度收缩；
 * 手机端标签改成单行（名称 + 金额），把省下的高度还给流带。
 */

export interface SankeyLayout {
  /** 宽屏（≥720px）：保留两行标签与更宽松的留白。 */
  wide: boolean;
  /** 标签文字可用宽度（px）。 */
  labelWidth: number;
  /** 标签与节点之间的间距（px）。 */
  labelGap: number;
  /** 桑基图左右各留多少边距给标签列（px）。 */
  sideMargin: number;
  nodeWidth: number;
  nodeGap: number;
  fontSize: number;
  amountFontSize: number;
  lineHeight: number;
}

export function sankeyLayoutFor(width: number): SankeyLayout {
  const w = Math.max(240, Math.round(Number.isFinite(width) ? width : 0) || 240);
  const wide = w >= 720;
  // 手机端标签列占 24%（78–118px），保证「名称 + 金额」单行可读，又不至于把流带挤没。
  const labelWidth = wide ? 155 : Math.max(78, Math.min(118, Math.round(w * 0.24)));
  const labelGap = wide ? 10 : 6;
  return {
    wide,
    labelWidth,
    labelGap,
    sideMargin: labelWidth + labelGap + 2,
    nodeWidth: wide ? 14 : 11,
    // 节点间距必须大于标签行高，否则小持仓的标签会与邻标签重叠、被 ECharts 的 hideOverlap
    // 悄悄藏掉（实测：宽屏两行标签需要 ≥30，手机单行标签需要 ≥14）。手机端再放宽一点，
    // 让下面几行小持仓不被挤成一堆。
    nodeGap: wide ? 32 : 24,
    fontSize: wide ? 11 : 10,
    amountFontSize: wide ? 10 : 9,
    lineHeight: wide ? 15 : 13
  };
}

/**
 * 画布高度随持仓数量增长：节点越多越长。
 *
 * 这里是按「手机」的观感定的预算（每只持仓 76px）：手机宽 390 时画布只有 390px 宽，
 * 若高度还只有 ~390px，六行持仓会挤成一个方块，曲线也被压得很扁。桌面端宽度足够，
 * 不需要这么高，由 app/globals.css 的 `min(var(--sankey-canvas-height), 460px)` 收住。
 * 360px 下限保证只有两三只持仓时也不发扁，980px 上限避免长到需要翻好几屏。
 */
export function sankeyCanvasHeight(maxNodes: number): number {
  const nodes = Math.max(0, Math.round(Number.isFinite(maxNodes) ? maxNodes : 0) || 0);
  return Math.min(980, Math.max(360, nodes * 76 + 96));
}
