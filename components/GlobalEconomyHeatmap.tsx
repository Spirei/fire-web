"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import echarts, { type EChartsInstance } from "@/lib/echarts";
import { WORLD_ECONOMY_INDICATORS, type WorldEconomyCountry, type WorldEconomyIndicator } from "@/lib/worldEconomy";
import { countryCatalogForMapNames, countryNameZh, type CountryCatalogItem } from "@/lib/countryCatalog";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { defaultFlagUrl } from "@/lib/flagAssets";

interface EconomyResponse {
  indicator: WorldEconomyIndicator;
  year: number;
  meta: (typeof WORLD_ECONOMY_INDICATORS)[WorldEconomyIndicator];
  countries: WorldEconomyCountry[];
  g20: WorldEconomyCountry[];
  thresholds: number[];
  source: string;
  error?: string;
}

interface PaletteMode {
  colors: string[];
  border: string;
  body: string;
  empty: string;
  text: string;
  muted: string;
  tooltip: string;
  divider: string;
}

type EconomyRegion = "world" | "g20" | "north-america" | "europe" | "mea" | "latin-america" | "asia-pacific";
type EconomyViewMode = "map" | "ranking";

interface EconomyRegionOption {
  key: EconomyRegion;
  label: string;
  count: number;
  iso2?: Set<string>;
}

function isoSet(codes: string) {
  return new Set(codes.trim().split(/\s+/));
}

// 分区参照 TradingView 的全球经济分组。count 保留其产品口径；
// iso2 用于地图聚焦和弱化非本区域国家，包含地图中可见的主要经济体。
const ECONOMY_REGIONS: EconomyRegionOption[] = [
  { key: "world", label: "世界", count: 184 },
  { key: "g20", label: "G20", count: 20, iso2: isoSet("AR AU BR CA CN FR DE IN ID IT JP MX RU SA ZA KR TR GB US") },
  { key: "north-america", label: "北美", count: 8, iso2: isoSet("US CA GL BM PM BS CU JM") },
  { key: "europe", label: "欧洲", count: 46, iso2: isoSet("AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA") },
  { key: "mea", label: "中东/非洲", count: 70, iso2: isoSet("DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW BH IR IQ IL JO KW LB OM PS QA SA SY AE YE TR") },
  { key: "latin-america", label: "墨西哥和南美", count: 23, iso2: isoSet("MX BZ CR SV GT HN NI PA AR BO BR CL CO EC GY PY PE SR UY VE GF FK TT DO HT") },
  { key: "asia-pacific", label: "亚太", count: 36, iso2: isoSet("AF AU BD BT BN KH CN FJ IN ID JP KZ KI KG LA MY MV MH FM MN MM NR NP NZ KP PK PW PG PH WS SG SB KR LK TJ TH TL TM TO TV UZ VU VN") }
];

// TradingView color-heatmap presets. The order is xs → xxl.
const PALETTES: Record<string, { light: PaletteMode; dark: PaletteMode }> = {
  orange: {
    light: { colors: ["#fff3e0", "#ffe0b2", "#ffb74d", "#ff9800", "#f57c00", "#e65100"], border: "#e65100", body: "#ffffff", empty: "#f2f2f2", text: "#0f0f0f", muted: "#707070", tooltip: "#ffffff", divider: "#ebebeb" },
    dark: { colors: ["#33261a", "#593a1b", "#8c541c", "#ff9800", "#ffb74d", "#ffcc80"], border: "#ffe0b2", body: "#000000", empty: "#2e2e2e", text: "#dbdbdb", muted: "#8c8c8c", tooltip: "#1f1f1f", divider: "#3d3d3d" }
  },
  blue: {
    light: { colors: ["#ede7f6", "#d1c4e9", "#9575cd", "#7e57c2", "#5e35b1", "#311b92"], border: "#311b92", body: "#ffffff", empty: "#f2f2f2", text: "#0f0f0f", muted: "#707070", tooltip: "#ffffff", divider: "#ebebeb" },
    dark: { colors: ["#311b92", "#512da8", "#673ab7", "#7e57c2", "#9575cd", "#b39ddb"], border: "#d1c4e9", body: "#000000", empty: "#2e2e2e", text: "#dbdbdb", muted: "#8c8c8c", tooltip: "#1f1f1f", divider: "#3d3d3d" }
  },
  cyan: {
    light: { colors: ["#e3effd", "#bbd9fb", "#5b9cf6", "#2962ff", "#1848cc", "#0c3299"], border: "#0c3299", body: "#ffffff", empty: "#f2f2f2", text: "#0f0f0f", muted: "#707070", tooltip: "#ffffff", divider: "#ebebeb" },
    dark: { colors: ["#132042", "#142e61", "#143a87", "#2962ff", "#5b9cf6", "#90bff9"], border: "#bbd9fb", body: "#000000", empty: "#2e2e2e", text: "#dbdbdb", muted: "#8c8c8c", tooltip: "#1f1f1f", divider: "#3d3d3d" }
  },
  pink: {
    light: { colors: ["#fce4ec", "#f8bbd0", "#f06292", "#e91e63", "#c2185b", "#880e4f"], border: "#880e4f", body: "#ffffff", empty: "#f2f2f2", text: "#0f0f0f", muted: "#707070", tooltip: "#ffffff", divider: "#ebebeb" },
    dark: { colors: ["#880e4f", "#ad1457", "#c2185b", "#e91e63", "#f06292", "#f48fb1"], border: "#f8bbd0", body: "#000000", empty: "#2e2e2e", text: "#dbdbdb", muted: "#8c8c8c", tooltip: "#1f1f1f", divider: "#3d3d3d" }
  },
  sky: {
    light: { colors: ["#e0f7fa", "#b2ebf2", "#4dd0e1", "#00bcd4", "#0097a7", "#006064"], border: "#006064", body: "#ffffff", empty: "#f2f2f2", text: "#0f0f0f", muted: "#707070", tooltip: "#ffffff", divider: "#ebebeb" },
    dark: { colors: ["#006064", "#00838f", "#0097a7", "#00bcd4", "#4dd0e1", "#80deea"], border: "#b2ebf2", body: "#000000", empty: "#2e2e2e", text: "#dbdbdb", muted: "#8c8c8c", tooltip: "#1f1f1f", divider: "#3d3d3d" }
  },
  green: {
    light: { colors: ["#daf2e6", "#ace5c9", "#42bd7f", "#089950", "#056636", "#1a3326"], border: "#1a3326", body: "#ffffff", empty: "#f2f2f2", text: "#0f0f0f", muted: "#707070", tooltip: "#ffffff", divider: "#ebebeb" },
    dark: { colors: ["#1a3326", "#004d27", "#056636", "#089950", "#42bd7f", "#70cc9e"], border: "#ace5c9", body: "#000000", empty: "#2e2e2e", text: "#dbdbdb", muted: "#8c8c8c", tooltip: "#1f1f1f", divider: "#3d3d3d" }
  }
};

let worldMapPromise: Promise<CountryCatalogItem[]> | null = null;
const economyResponseCache = new Map<string, EconomyResponse>();
const economyResponseInflight = new Map<string, Promise<EconomyResponse>>();

type WorldMapGeometry = { coordinates?: unknown };
type WorldMapFeature = { properties?: { name?: string }; geometry?: WorldMapGeometry };
type WorldMapGeoJson = { features?: WorldMapFeature[] };

/**
 * Natural Earth 把跨日期变更线的离岛按 [-180, 180] 分拆。对于主体位于
 * 东半球的国家，这会把俄罗斯远东、新西兰和斐济的一小部分画到最左侧，
 * 悬浮轮廓也会横跨整幅地图。TradingView 的世界构图会把这些离岛连续保留
 * 在右侧；基里巴斯则连续保留在左侧。美国的阿留申群岛本来就横跨两端，
 * 必须保持原状。
 */
function keepDatelineCountriesContinuous(world: WorldMapGeoJson) {
  const sideByCountry = new Map<string, "east" | "west">([
    ["Russia", "east"],
    ["New Zealand", "east"],
    ["Fiji", "east"],
    ["Kiribati", "west"]
  ]);

  const visitCoordinates = (node: unknown, side: "east" | "west") => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      if (side === "east" && node[0] < 0) node[0] += 360;
      if (side === "west" && node[0] > 0) node[0] -= 360;
      return;
    }
    node.forEach((child) => visitCoordinates(child, side));
  };

  for (const feature of world.features ?? []) {
    const side = sideByCountry.get(feature.properties?.name ?? "");
    if (side) visitCoordinates(feature.geometry?.coordinates, side);
  }
  return world;
}

function loadEconomyResponse(indicator: WorldEconomyIndicator, year: number) {
  const key = `${indicator}:${year}`;
  const cached = economyResponseCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = economyResponseInflight.get(key);
  if (pending) return pending;
  const request = fetch(`/api/world-economy?indicator=${indicator}&year=${year}`)
    .then(async (response) => {
      const body = await response.json() as EconomyResponse;
      if (!response.ok) throw new Error(body.error || "数据加载失败");
      economyResponseCache.set(key, body);
      return body;
    })
    .finally(() => economyResponseInflight.delete(key));
  economyResponseInflight.set(key, request);
  return request;
}

function ensureWorldMap() {
  if (!worldMapPromise) {
    worldMapPromise = fetch("/maps-world.json")
      .then((response) => {
        if (!response.ok) throw new Error("地图资源加载失败");
        return response.json() as Promise<WorldMapGeoJson>;
      })
      .then((world) => {
        keepDatelineCountriesContinuous(world);
        echarts.registerMap("fire-world", world as Parameters<typeof echarts.registerMap>[1]);
        return countryCatalogForMapNames((world.features ?? []).map((feature) => feature.properties?.name ?? ""));
      })
      .catch((error) => {
        worldMapPromise = null;
        throw error;
      });
  }
  return worldMapPromise;
}

function fmtValue(value: number, unit: string) {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: digits })}${unit}`;
}

function fmtLegendValue(value: number) {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}

function flagFallbackMarkup(hidden = false) {
  return `<span style="display:${hidden ? "none" : "grid"};width:20px;height:20px;place-items:center;border-radius:50%;background:#f1f3f5;color:#6b7280"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.45 3.6 5.45 3.6 9S14.4 18.55 12 21c-2.4-2.45-3.6-5.45-3.6-9S9.6 5.45 12 3Z"/></svg></span>`;
}

function flagMarkup(country: Pick<CountryCatalogItem, "iso2" | "flagCode">, customUrl?: string) {
  const fallback = flagFallbackMarkup(!!country.flagCode);
  if (!country.flagCode) return fallback;
  // 默认本地素材库圆形 SVG（hatscripts/circle-flags，public/uploads/asset/flag/{iso2}.svg），自定义旗帜优先
  const src = customUrl || defaultFlagUrl(country.flagCode);
  return `<img src="${escapeHtml(src)}" alt="" style="display:block;width:20px;height:20px;object-fit:cover;border-radius:50%" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"/>${fallback}`;
}

function CountryFlag({ iso2, customUrl }: { iso2: string; flag?: string; customUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const src = customUrl || (iso2 ? defaultFlagUrl(iso2) : "");
  useEffect(() => setFailed(false), [src]);
  return (
    <span className="economy-ranking-flag" aria-hidden="true">
      {src && !failed ? <img src={src} alt="" className="h-full w-full rounded-full object-cover" onError={() => setFailed(true)} /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[62%] w-[62%] text-muted"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.4 2.45 3.6 5.45 3.6 9S14.4 18.55 12 21c-2.4-2.45-3.6-5.45-3.6-9S9.6 5.45 12 3Z" /></svg>}
    </span>
  );
}

interface MapHoverEvent {
  componentType?: string;
  dataIndex?: number;
  name?: string;
  event?: {
    target?: {
      id?: string | number;
      __svgEl?: SVGPathElement;
      __svgPathBuilder?: { getStr?: () => string };
    };
  };
}

function clearMapHoverOutline(root: HTMLElement | null) {
  root?.querySelector("[data-fire-map-hover-outline]")?.remove();
}

/**
 * TradingView 的国家悬浮态不是发光或阴影，而是独立于底图的双层矢量轮廓：
 * 浅色外沿 + 黑色内沿。ECharts 原生 emphasis 只能画一条描边，
 * 因此在 SVG renderer 的命中路径上复制两层轮廓，几何精度与底图完全一致。
 * 宽度按主题分别校准：浅色画布的高反差会放大线宽感，因此应比深色更细。
 */
function drawMapHoverOutline(root: HTMLElement | null, params: MapHoverEvent, outerColor: string, dark: boolean) {
  if (!root) return;
  clearMapHoverOutline(root);
  const svg = root.querySelector("svg");
  if (!svg) return;

  const target = params.event?.target;
  let source = target?.__svgEl instanceof SVGPathElement ? target.__svgEl : null;
  if (!source && target?.id != null) {
    const targetId = String(target.id);
    source = Array.from(svg.querySelectorAll<SVGPathElement>("path"))
      .find((path) => path.getAttribute("data-zr-dom-id") === targetId) ?? null;
  }
  // ECharts 6 的虚拟 SVG painter 不再把 zrender id 写进 path；其 path builder
  // 仍保留与 DOM 完全相同的 d，因此可无损定位当前国家。
  if (!source && target?.__svgPathBuilder?.getStr) {
    const pathData = target.__svgPathBuilder.getStr();
    source = Array.from(svg.querySelectorAll<SVGPathElement>("path"))
      .find((path) => path.getAttribute("d") === pathData) ?? null;
  }
  // SSR 属性在开发/测试渲染中也会保留，作为不同 ECharts painter 的兼容回退。
  if (!source && params.dataIndex != null) {
    source = svg.querySelector<SVGPathElement>(`path[ecmeta_series_index="0"][ecmeta_data_index="${params.dataIndex}"]`);
  }
  if (!source || !source.parentNode) return;

  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("data-fire-map-hover-outline", "");
  group.setAttribute("class", "economy-map-hover-outline");
  group.setAttribute("pointer-events", "none");

  const makeOutline = (stroke: string, width: number) => {
    const path = source!.cloneNode(true) as SVGPathElement;
    path.removeAttribute("class");
    path.removeAttribute("filter");
    path.removeAttribute("opacity");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", stroke);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    path.setAttribute("pointer-events", "none");
    return path;
  };

  group.append(
    makeOutline(outerColor, dark ? 2.3 : 1.65),
    makeOutline("#000000", dark ? 0.72 : 0.46)
  );
  source.parentNode.appendChild(group);
}

function pieceIndexFor(value: number, thresholds: number[]) {
  for (let index = 0; index < thresholds.length; index += 1) {
    if (value <= thresholds[index]) return index;
  }
  return thresholds.length;
}

function pieceRangeLabel(index: number, thresholds: number[], minValue: number, maxValue: number, unit: string) {
  const start = index === 0 ? minValue : thresholds[index - 1];
  const end = index === thresholds.length ? maxValue : thresholds[index];
  return `${fmtLegendValue(start)}到${fmtLegendValue(end)}${unit}`;
}

function segmentPath(x: number, width: number, index: number, inner = false) {
  const top = inner ? 25 : 24;
  const bottom = inner ? 31 : 32;
  const middle = 28;
  const left = x + (inner ? 1 : 0);
  const right = x + width - (inner ? 1 : 0);
  const shoulder = inner ? 5.7 : 4.7;
  if (index === 0) return `M${right} ${top} L${left + shoulder} ${top} L${left} ${middle} L${left + shoulder} ${bottom} L${right} ${bottom} Z`;
  if (index === 5) return `M${left} ${top} L${right - shoulder} ${top} L${right} ${middle} L${right - shoulder} ${bottom} L${left} ${bottom} Z`;
  return `M${left} ${top} L${right} ${top} L${right} ${bottom} L${left} ${bottom} Z`;
}

interface HeatmapLegendProps {
  colors: string[];
  borderColor: string;
  bodyColor: string;
  textColor: string;
  thresholds: number[];
  minValue: number;
  maxValue: number;
  unit: string;
  activeIndex: number | null;
  tooltipIndex: number | null;
  onHover: (index: number) => void;
  onLeave: () => void;
  onToggle: (index: number) => void;
}

function HeatmapLegend({ colors, borderColor, bodyColor, textColor, thresholds, minValue, maxValue, unit, activeIndex, tooltipIndex, onHover, onLeave, onToggle }: HeatmapLegendProps) {
  const gap = 2;
  const segmentWidth = (600 - gap * 5) / 6;
  const tooltipText = tooltipIndex == null ? "" : pieceRangeLabel(tooltipIndex, thresholds, minValue, maxValue, unit);

  return (
    <div className="economy-heatmap-legend" onMouseLeave={onLeave}>
      {tooltipIndex != null && (
        <div className="economy-legend-tooltip" style={{ left: `${Math.max(11, Math.min(89, ((tooltipIndex + 0.5) / 6) * 100))}%` }} role="status">
          {tooltipText}
        </div>
      )}
      <div className="economy-legend-labels" aria-hidden="true">
        {thresholds.map((threshold, index) => (
          <span key={threshold} style={{ left: `${((index + 1) / 6) * 100}%` }}>{fmtLegendValue(threshold)}{unit}</span>
        ))}
      </div>
      <svg viewBox="0 0 600 34" preserveAspectRatio="none" aria-label="地图数值色阶">
        {colors.map((color, index) => {
          const x = index * (segmentWidth + gap);
          const active = activeIndex === index;
          const range = pieceRangeLabel(index, thresholds, minValue, maxValue, unit);
          return (
            <g
              key={`${color}-${index}`}
              className={`economy-legend-segment${active ? " is-active" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={range}
              aria-pressed={active}
              onMouseEnter={() => onHover(index)}
              onFocus={() => onHover(index)}
              onBlur={onLeave}
              onClick={() => onToggle(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(index); }
              }}
            >
              <title>{range}</title>
              <rect x={x} y="8" width={segmentWidth} height="24" fill="transparent" pointerEvents="all" />
              <path d={segmentPath(x, segmentWidth, index)} fill={color} stroke={active ? borderColor : "none"} strokeWidth={active ? 2 : 0} strokeLinejoin="miter" />
              <path d={segmentPath(x, segmentWidth, index, true)} fill={color} stroke={active ? bodyColor : "none"} strokeWidth={active ? 1 : 0} strokeLinejoin="miter" />
            </g>
          );
        })}
      </svg>
      <span className="sr-only" style={{ color: textColor }}>悬浮国家或色阶可双向联动，点击色阶可锁定范围</span>
    </div>
  );
}

export default function GlobalEconomyHeatmap() {
  const { countryFlags } = useAssetIcons(["flag"]);
  const currentYear = new Date().getFullYear();
  const chartRef = useRef<HTMLDivElement>(null);
  const regionMenuRef = useRef<HTMLDivElement>(null);
  const chartInst = useRef<EChartsInstance | null>(null);
  const chartViewRef = useRef<EconomyViewMode>("map");
  const requestId = useRef(0);
  const [indicator, setIndicator] = useState<WorldEconomyIndicator>("inflation");
  const [year, setYear] = useState(currentYear - 1);
  const [data, setData] = useState<EconomyResponse | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [countryCatalog, setCountryCatalog] = useState<CountryCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [dark, setDark] = useState(false);
  const [legendHoverIndex, setLegendHoverIndex] = useState<number | null>(null);
  const [lockedPieceIndex, setLockedPieceIndex] = useState<number | null>(null);
  const [countryPieceIndex, setCountryPieceIndex] = useState<number | null>(null);
  const [region, setRegion] = useState<EconomyRegion>("world");
  const [regionOpen, setRegionOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewMode, setViewMode] = useState<EconomyViewMode>("map");
  // 默认保留完整世界构图。此前 1.7 会把阿拉斯加、俄罗斯远东和太平洋离岛
  // 推到画幅边缘，视觉上误判为底图几何缺失；1.3 更接近 TradingView 的占比。
  const [mapZoom, setMapZoom] = useState(1.3);

  const mapFilterIndex = legendHoverIndex ?? lockedPieceIndex;
  const activeLegendIndex = mapFilterIndex ?? countryPieceIndex;
  const activeRegion = ECONOMY_REGIONS.find((item) => item.key === region) ?? ECONOMY_REGIONS[0];

  useEffect(() => {
    if (!regionOpen) return;
    const close = (event: PointerEvent) => {
      if (!regionMenuRef.current?.contains(event.target as Node)) setRegionOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRegionOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [regionOpen]);

  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.body.style.overflow = "hidden";
    document.body.classList.add("economy-map-fullscreen-open");
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.body.classList.remove("economy-map-fullscreen-open");
      document.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  const toggleFullscreen = () => setFullscreen((value) => !value);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureWorldMap()
      .then((catalog) => {
        if (cancelled) return;
        setCountryCatalog(catalog);
        setMapReady(true);
      })
      .catch(() => { if (!cancelled) setError("世界地图资源加载失败，请刷新后重试"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!playing || refreshing || data?.indicator !== indicator || data.year !== year) return;
    const nextYear = year >= currentYear ? 2000 : year + 1;
    void loadEconomyResponse(indicator, nextYear).catch(() => {});
    const timer = window.setTimeout(() => setYear(nextYear), 900);
    return () => window.clearTimeout(timer);
  }, [playing, refreshing, data, indicator, year, currentYear]);

  useEffect(() => {
    setLegendHoverIndex(null);
    setLockedPieceIndex(null);
    setCountryPieceIndex(null);
  }, [indicator, year]);

  useEffect(() => {
    const id = ++requestId.current;
    const cached = economyResponseCache.get(`${indicator}:${year}`);
    const canPreserveMap = data?.indicator === indicator;
    if (cached) {
      setData(cached);
      setLoading(false);
      setRefreshing(false);
      setError("");
      return;
    }
    setLoading(!canPreserveMap);
    setRefreshing(canPreserveMap);
    void loadEconomyResponse(indicator, year)
      .then((body) => {
        if (id !== requestId.current) return;
        setData(body);
        setError("");
      })
      .catch((reason: Error) => {
        if (id === requestId.current) setError(reason.message);
      })
      .finally(() => {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  }, [indicator, year]);

  useEffect(() => {
    if (!chartRef.current || !data || !mapReady) return;
    const palette = PALETTES[data.meta.palette][dark ? "dark" : "light"];
    const baseBorderWidth = dark ? 0.46 : 0.28;
    const filteredBorderWidth = dark ? 0.86 : 0.52;
    const emphasisBorderWidth = dark ? 0.72 : 0.42;
    const lookup = new Map(data.countries.map((item) => [item.mapName, item]));
    const countryLookup = new Map(countryCatalog.map((item) => [item.mapName, item]));
    const chart = chartInst.current ?? echarts.init(chartRef.current, null, { renderer: "svg" });
    chartInst.current = chart;
    clearMapHoverOutline(chartRef.current);

    const mapData = data.countries.map((item) => {
      const pieceIndex = pieceIndexFor(item.value, data.thresholds);
      const matchesRegion = !activeRegion.iso2 || activeRegion.iso2.has(item.flagCode.toUpperCase());
      const matchesLegend = mapFilterIndex == null || pieceIndex === mapFilterIndex;
      const highlighted = matchesRegion && mapFilterIndex != null && matchesLegend;
      const color = palette.colors[pieceIndex];
      return {
        name: item.mapName,
        value: item.value,
        code: item.code,
        pieceIndex,
        itemStyle: {
          areaColor: matchesRegion ? color : palette.empty,
          opacity: !matchesRegion ? 1 : matchesLegend ? 1 : 0.4,
          borderColor: highlighted ? palette.border : "#000000",
          borderWidth: highlighted ? filteredBorderWidth : baseBorderWidth,
          shadowBlur: 0,
          shadowColor: "transparent"
        },
        emphasis: {
          itemStyle: {
            areaColor: color,
            opacity: 1,
            borderColor: "#000000",
            borderWidth: emphasisBorderWidth,
            shadowBlur: 0,
            shadowColor: "transparent"
          }
        }
      };
    });

    const viewChanged = chartViewRef.current !== viewMode;
    chartViewRef.current = viewMode;
    if (viewChanged) chart.clear();

    if (viewMode === "ranking") {
      const regionCountries = data.countries
        .filter((item) => !activeRegion.iso2 || activeRegion.iso2.has(item.flagCode.toUpperCase()))
        .filter((item) => mapFilterIndex == null || pieceIndexFor(item.value, data.thresholds) === mapFilterIndex)
        .sort((left, right) => right.value - left.value)
        .slice(0, 30);
      const catalogByIso = new Map(countryCatalog.map((item) => [item.iso2, item]));
      chart.setOption({
        backgroundColor: "transparent",
        animation: true,
        animationDuration: 360,
        animationDurationUpdate: 180,
        animationEasing: "cubicOut",
        animationEasingUpdate: "cubicOut",
        aria: { enabled: true, description: `${data.meta.title}国家排行榜，按数值从高到低排列。` },
        grid: { top: 50, right: 70, bottom: 28, left: 24, containLabel: true },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow", shadowStyle: { color: dark ? "rgba(255,255,255,.055)" : "rgba(15,23,42,.045)" } },
          confine: true,
          borderWidth: 0,
          backgroundColor: palette.tooltip,
          textStyle: { color: palette.text, fontSize: 14 },
          extraCssText: "border-radius:12px;box-shadow:none;padding:10px 12px",
          formatter: (params: Array<{ dataIndex: number }>) => {
            const index = params[0]?.dataIndex ?? 0;
            const item = regionCountries[index];
            if (!item) return "";
            const country = catalogByIso.get(item.flagCode.toUpperCase());
            const identity = country ?? { iso2: item.flagCode.toUpperCase(), flag: item.flag, flagCode: item.flagCode };
            return `<div style="display:flex;align-items:center;gap:8px">${flagMarkup(identity, countryFlags[item.flagCode.toUpperCase()])}<strong>${escapeHtml(country?.name || countryNameZh(item.flagCode, item.name))}</strong><span style="margin-left:8px">${escapeHtml(fmtValue(item.value, data.meta.unit))}</span></div>`;
          }
        },
        xAxis: {
          type: "value",
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: palette.muted, fontSize: 11, formatter: (value: number) => `${fmtLegendValue(value)}${data.meta.unit}` },
          splitLine: { lineStyle: { color: palette.divider, width: 1 } }
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: regionCountries.map((item) => catalogByIso.get(item.flagCode.toUpperCase())?.name || item.name),
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: palette.text, fontSize: 12, width: 96, overflow: "truncate", margin: 12 }
        },
        series: [{
          name: data.meta.title,
          type: "bar",
          barMaxWidth: 18,
          data: regionCountries.map((item) => ({
            value: item.value,
            itemStyle: { color: palette.colors[pieceIndexFor(item.value, data.thresholds)], borderRadius: [0, 4, 4, 0] }
          })),
          label: { show: true, position: "right", color: palette.text, fontSize: 11, formatter: (params: { value: number }) => fmtValue(params.value, data.meta.unit) }
        }]
      }, { notMerge: true });
    } else chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 420,
      animationDurationUpdate: 180,
      animationEasing: "cubicOut",
      animationEasingUpdate: "cubicOut",
      aria: { enabled: true, description: `${data.meta.title}世界地图，悬浮国家查看数值，悬浮下方色阶筛选国家。` },
      tooltip: {
        trigger: "item",
        showDelay: 90,
        hideDelay: 45,
        transitionDuration: 0.14,
        confine: true,
        borderWidth: 0,
        borderColor: "transparent",
        backgroundColor: palette.tooltip,
        textStyle: { color: palette.text, fontSize: 14, lineHeight: 21 },
        extraCssText: "border-radius:14px;box-shadow:none;padding:10px 12px",
        position: (point: number[], _params: unknown, _element: HTMLElement, _rect: unknown, size: { contentSize: number[]; viewSize: number[] }) => {
          const gap = 14;
          const left = point[0] + gap + size.contentSize[0] > size.viewSize[0] ? point[0] - size.contentSize[0] - gap : point[0] + gap;
          const top = Math.max(6, Math.min(size.viewSize[1] - size.contentSize[1] - 6, point[1] - size.contentSize[1] / 2));
          return [left, top];
        },
        formatter: (params: { name: string }) => {
          const item = lookup.get(params.name);
          const country = countryLookup.get(params.name);
          const iso2 = country?.iso2 || item?.flagCode.toUpperCase() || "";
          const identity = country ?? { iso2, flagCode: item?.flagCode || "" };
          const flag = flagMarkup(identity, countryFlags[iso2]);
          const countryName = country?.name || countryNameZh(iso2, item?.name || params.name);
          const heading = `<div style="display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;line-height:20px"><span style="display:grid;width:20px;height:20px;flex:none;place-items:center;overflow:hidden;border-radius:50%">${flag}</span><span>${escapeHtml(countryName)}</span></div>`;
          if (!item) return `<div style="min-width:196px">${heading}<div style="margin-top:4px;color:${palette.muted};font-size:14px;line-height:20px">暂无数据</div></div>`;
          const tooltipValue = fmtValue(item.value, data.meta.unit).replace(/%$/, " %");
          return `<div style="min-width:196px">${heading}<div style="margin-top:4px;font-size:14px;line-height:20px"><span style="color:${palette.text};font-weight:500">${tooltipValue}</span><span style="color:${palette.muted}"> 在 ${item.year}年</span></div></div>`;
        }
      },
      series: [{
        name: data.meta.title,
        type: "map",
        map: "fire-world",
        roam: "move",
        scaleLimit: { min: 1.1, max: 2.5 },
        // TradingView 的 745×372 世界底图比 ECharts 默认投影略扁、横向更舒展。
        // 0.84 配合 112% 画幅可保持完整世界构图，同时减少两侧无效黑边。
        aspectScale: 0.84,
        zoom: mapZoom,
        layoutCenter: ["50%", "52%"],
        layoutSize: "112%",
        selectedMode: false,
        data: mapData,
        label: { show: false },
        itemStyle: { areaColor: palette.empty, borderColor: "#000000", borderWidth: baseBorderWidth },
        emphasis: {
          focus: "none",
          label: { show: false },
          itemStyle: { areaColor: palette.empty, borderColor: "#000000", borderWidth: emphasisBorderWidth, shadowBlur: 0, shadowColor: "transparent" }
        }
      }]
    }, { notMerge: false, replaceMerge: ["series"] });

    chart.off("mouseover");
    chart.off("mouseout");
    chart.on("mouseover", (params: MapHoverEvent) => {
      if (viewMode !== "map" || params.componentType !== "series" || !params.name) return;
      const item = lookup.get(params.name);
      setCountryPieceIndex(item ? pieceIndexFor(item.value, data.thresholds) : null);
      drawMapHoverOutline(chartRef.current, params, palette.border, dark);
    });
    chart.on("mouseout", () => {
      setCountryPieceIndex(null);
      clearMapHoverOutline(chartRef.current);
    });
    chart.getZr().off("globalout");
    chart.getZr().on("globalout", () => {
      setCountryPieceIndex(null);
      clearMapHoverOutline(chartRef.current);
    });
  }, [data, dark, mapFilterIndex, mapReady, countryCatalog, countryFlags, activeRegion, viewMode, mapZoom]);

  useEffect(() => {
    let frame = 0;
    const resize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const chart = chartInst.current;
        const element = chartRef.current;
        if (!chart || chart.isDisposed() || !element || element.clientWidth < 1 || element.clientHeight < 1) return;
        try {
          chart.resize({ width: element.clientWidth, height: element.clientHeight, silent: true });
        } catch {
          // 全屏切换时 ECharts 的 geo transform 可能短暂为空，下一次
          // ResizeObserver 回调会在布局稳定后完成尺寸同步。
        }
      });
    };
    const observer = typeof ResizeObserver === "undefined" || !chartRef.current ? null : new ResizeObserver(resize);
    if (chartRef.current) observer?.observe(chartRef.current);
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => () => { chartInst.current?.dispose(); chartInst.current = null; }, []);

  const palette = PALETTES[data?.meta.palette ?? WORLD_ECONOMY_INDICATORS[indicator].palette][dark ? "dark" : "light"];
  const valueRange = useMemo(() => {
    const values = data?.countries.map((item) => item.value).filter(Number.isFinite) ?? [];
    return { min: values.length ? Math.min(...values) : 0, max: values.length ? Math.max(...values) : 0 };
  }, [data]);
  const latestYear = useMemo(() => Math.max(0, ...(data?.countries.map((item) => item.year) ?? [])), [data]);

  const handleLegendHover = (index: number) => {
    setLegendHoverIndex(index);
    setCountryPieceIndex(null);
  };

  return (
    <section className="economy-heatmap flex flex-col gap-5">
      <header className="economy-heatmap-header flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">全球经济热图</h2>
          <p className="mt-0.5 text-xs text-muted">跨国家比较关键宏观指标 · 数据来源 World Bank Open Data · 不同国家发布周期可能不同</p>
        </div>
        <div className="economy-indicator-tabs -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 pt-1">
          {(Object.entries(WORLD_ECONOMY_INDICATORS) as [WorldEconomyIndicator, (typeof WORLD_ECONOMY_INDICATORS)[WorldEconomyIndicator]][]).map(([key, meta]) => (
            <button key={key} type="button" onClick={() => setIndicator(key)} className={`economy-indicator-pill ${indicator === key ? "is-active" : ""}`}>
              {meta.shortTitle}
            </button>
          ))}
        </div>
      </header>

      <div className="economy-map-layout min-w-0">
        <div className={`economy-map-card relative min-w-0 overflow-hidden ${fullscreen ? "is-map-fullscreen" : ""}`}>
          <div className="economy-map-title-row flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-ink">{data?.meta.title ?? WORLD_ECONOMY_INDICATORS[indicator].title}</h3>
              <p className="mt-1 text-xs text-muted">{data?.meta.description ?? WORLD_ECONOMY_INDICATORS[indicator].description}</p>
            </div>
            <span className="economy-map-updated flex-none text-xs tabular-nums text-muted">更新至 {latestYear || year}</span>
          </div>

          <div className="economy-map-stage relative">
            <div ref={regionMenuRef} className="economy-region-picker">
              <button
                type="button"
                className={`economy-region-trigger ${regionOpen ? "is-open" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={regionOpen}
                onClick={() => setRegionOpen((value) => !value)}
              >
                <span>{activeRegion.label}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 10 5-5 5 5" /></svg>
              </button>
              {regionOpen && (
                <div className="economy-region-menu" role="listbox" aria-label="地图区域">
                  {ECONOMY_REGIONS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="option"
                      aria-selected={region === item.key}
                      className={`economy-region-option ${region === item.key ? "is-active" : ""}`}
                      onClick={() => { setRegion(item.key); setRegionOpen(false); }}
                    >
                      <span>{item.label}</span>
                      <span className="economy-region-count">{item.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="economy-map-tools">
              <button type="button" className="economy-map-tool" onClick={toggleFullscreen} title={fullscreen ? "退出全屏（Esc）" : "全屏模式"} aria-label={fullscreen ? "退出全屏" : "全屏模式"}>
                {fullscreen ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></svg>
                )}
              </button>
              <div className="economy-map-view-switch" role="group" aria-label="地图显示方式">
                <button type="button" className={`economy-map-tool ${viewMode === "ranking" ? "is-active" : ""}`} onClick={() => setViewMode("ranking")} title="国家排行榜" aria-label="切换到国家排行榜" aria-pressed={viewMode === "ranking"}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V11M9 19V6M14 19v-9M19 19V4" /><path d="M3 19.5h18" /></svg>
                </button>
                <button type="button" className={`economy-map-tool ${viewMode === "map" ? "is-active" : ""}`} onClick={() => setViewMode("map")} title="世界地图" aria-label="切换到世界地图" aria-pressed={viewMode === "map"}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.2 3.3 8.5S14.2 18.1 12 20.5M12 3.5C9.8 5.9 8.7 8.7 8.7 12s1.1 6.1 3.3 8.5" /></svg>
                </button>
              </div>
            </div>
            {viewMode === "map" && (
              <div className="economy-map-zoom" role="group" aria-label="地图缩放">
                <button type="button" onClick={() => setMapZoom((value) => Math.min(2.5, Number((value + 0.2).toFixed(2))))} disabled={mapZoom >= 2.5} aria-label="放大地图" title="放大地图">+</button>
                <button type="button" onClick={() => setMapZoom((value) => Math.max(1.1, Number((value - 0.2).toFixed(2))))} disabled={mapZoom <= 1.1} aria-label="缩小地图" title="缩小地图">−</button>
              </div>
            )}
            <div ref={chartRef} className={`economy-world-map w-full transition-opacity duration-200 ${loading && !data ? "opacity-0" : "opacity-100"}`} />
            {loading && !data && <div className="economy-map-skeleton pointer-events-none absolute inset-[8%_5%] animate-pulse rounded-[45%]" aria-label="加载地图数据" />}
            {error && <div className="absolute inset-x-4 top-5 rounded-lg border border-[#ef4444]/25 bg-[#ef4444]/10 px-4 py-3 text-center text-sm text-[#d33] dark:text-[#ff7777]">{error}</div>}
          </div>

          {fullscreen && <div className="economy-fullscreen-hint" role="status"><span>i</span>按 ESC 键退出全屏模式。</div>}

          <HeatmapLegend
            colors={palette.colors}
            borderColor={palette.border}
            bodyColor={palette.body}
            textColor={palette.muted}
            thresholds={data?.thresholds ?? [...WORLD_ECONOMY_INDICATORS[indicator].thresholds]}
            minValue={valueRange.min}
            maxValue={valueRange.max}
            unit={data?.meta.unit ?? "%"}
            activeIndex={activeLegendIndex}
            tooltipIndex={legendHoverIndex ?? lockedPieceIndex}
            onHover={handleLegendHover}
            onLeave={() => setLegendHoverIndex(null)}
            onToggle={(index) => setLockedPieceIndex((value) => value === index ? null : index)}
          />

          <div className="economy-year-control flex items-center gap-3">
            <button type="button" onClick={() => setPlaying((value) => !value)} className={`economy-year-play flex h-8 w-8 flex-none items-center justify-center rounded-full transition ${playing ? "is-playing" : ""}`} title={playing ? "暂停时间轴" : "播放历史变化"} aria-busy={playing && refreshing}>{playing ? "Ⅱ" : "▶"}</button>
            <span className="w-10 flex-none text-xs font-bold tabular-nums text-ink">{data?.indicator === indicator ? data.year : year}</span>
            <input aria-label="数据年份" type="range" min="2000" max={currentYear} value={year} onChange={(event) => { setPlaying(false); setYear(Number(event.target.value)); }} className="economy-year-range min-w-0 flex-1" />
            <span className="hidden flex-none text-[11px] text-faint sm:inline">2000 — {currentYear}</span>
          </div>
        </div>

        <aside className="economy-ranking-card">
          <div className="economy-ranking-header">
            <h3 className="text-base font-bold text-ink">G20 {data?.meta.shortTitle ?? "指标"}</h3>
          </div>
          <div className="economy-ranking-list">
            {(data?.g20 ?? []).map((item) => (
              <div key={item.code} className="economy-ranking-row flex items-center gap-2">
                <CountryFlag iso2={item.flagCode.toUpperCase()} flag={item.flag} customUrl={countryFlags[item.flagCode.toUpperCase()]} />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{item.name}</span>
                <span className="flex-none font-medium tabular-nums text-ink">{fmtValue(item.value, data?.meta.unit ?? "%")}</span>
              </div>
            ))}
          </div>
          {!loading && !data?.g20.length && <div className="px-5 py-16 text-center text-xs text-faint">该年份暂无 G20 数据</div>}
        </aside>
      </div>
    </section>
  );
}
