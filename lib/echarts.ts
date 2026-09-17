// K 线 / 柱状 / 折线 / 桑基用的核心包。地图与 SVG 渲染器见 lib/echarts-map.ts，
// 避免持仓页把 MapChart 打进首屏。新增图表类型时按使用面补注册。
import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, LineChart, SankeyChart } from "echarts/charts";
import {
  AxisPointerComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  CandlestickChart,
  LineChart,
  SankeyChart,
  AxisPointerComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer
]);

export type EChartsInstance = ReturnType<typeof echarts.init>;

export default echarts;
