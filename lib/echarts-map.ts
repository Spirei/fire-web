/** 全球经济热图专用：在核心图表包上再注册地图与 SVG 渲染器，避免持仓 K 线带上 MapChart。 */
import echarts from "./echarts";
import { MapChart } from "echarts/charts";
import { SVGRenderer } from "echarts/renderers";

echarts.use([MapChart, SVGRenderer]);

export type { EChartsInstance } from "./echarts";
export default echarts;
