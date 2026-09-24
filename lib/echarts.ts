// 按实际页面注册 K 线、柱状、折线与桑基组件，避免无关图表进入首屏包。
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
