// ECharts 按需引入：只注册全站实际用到的图表与组件，替代 `import * as echarts from "echarts"`，
// 避免把整套 ECharts（约 1MB）打进首屏包。新增图表类型/组件时在此补注册即可。
import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, LineChart, MapChart, SankeyChart } from "echarts/charts";
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
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  CandlestickChart,
  LineChart,
  MapChart,
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
  CanvasRenderer,
  SVGRenderer
]);

export type EChartsInstance = ReturnType<typeof echarts.init>;

export default echarts;
