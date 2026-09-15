"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import echarts, { type EChartsInstance } from "@/lib/echarts";
import MarketIcon from "@/components/MarketIcon";
import AppModal from "@/components/AppModal";
import { sankeyCanvasHeight, sankeyLayoutFor } from "@/lib/sankeyLayout";
import { MULTI_CURRENCIES } from "@/lib/currency";
import { localDateKey } from "@/lib/format";
import { showToast } from "@/lib/toast";

export interface PnlSankeyItem { name: string; code: string; market: string; pnl: number }
interface Props {
  profit: PnlSankeyItem[];
  loss: PnlSankeyItem[];
  profitTotal: number;
  lossTotal: number;
  rates: Record<string, number>;
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", HKD: "HK$", CNY: "¥", SGD: "S$", JPY: "¥", KRW: "₩", EUR: "€" };

function formatCurrency(value: number, currency: string) {
  const digits = currency === "JPY" || currency === "KRW" ? 0 : 2;
  return `${CURRENCY_SYMBOLS[currency] || `${currency} `}${Math.abs(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 块上金额缩写：≥1 亿显示亿、≥1 万显示万，其余保留两位，如 +$1.23万 / −¥5,678.90 */
function compactMoney(value: number, currency: string) {
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value);
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  if (abs >= 1e12) return `${sign}${symbol}${(abs / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${sign}${symbol}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${symbol}${(abs / 1e4).toFixed(2)}万`;
  return `${sign}${symbol}${abs.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function marketLabel(market: string) {
  return market === "US" ? "美股" : market === "HK" ? "港股" : market === "CN" ? "A股" : market;
}

/** 2 倍杠杆 ETF（名称含 2倍/2x 且带 ETF/做多/做空）只显示代码，正股显示名称 */
function displayName(item: PnlSankeyItem): string {
  const leveraged = /(\d+(?:\.\d+)?)\s*[xX倍]/.test(item.name) && /ETF|做多|做空/i.test(item.name);
  return leveraged ? item.code : (item.name || item.code);
}

const FALLBACK_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" rx="9" fill="#ffffff"/><path d="M6 21l5.5-6.5 4 3L26 10" fill="none" stroke="#3a3a46" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 10h4.4v4.4" fill="none" stroke="#3a3a46" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  );

export default function HoldingsPnlSankey({ profit, loss, profitTotal, lossTotal, rates }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const currencyMenuRef = useRef<HTMLDetailsElement>(null);
  const shareCardRef = useRef<HTMLDivElement>(null);
  const shareImgRef = useRef<HTMLImageElement>(null);
  const [currency, setCurrency] = useState("USD");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareDark, setShareDark] = useState(false);
  const [shareChartUrl, setShareChartUrl] = useState("");
  const [brand, setBrand] = useState({ logo: "", text: "Fire" });
  const empty = profit.length === 0 && loss.length === 0;
  const netTotal = profitTotal - lossTotal;
  const selectedCurrency = MULTI_CURRENCIES.find((item) => item.code === currency) || MULTI_CURRENCIES[0];
  const currencyRate = rates[currency] || (currency === "USD" ? 1 : 0);
  const convert = (value: number) => value * currencyRate;
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

  function buildOption(dark: boolean, width: number) {
    const ink = dark ? "#e6ebf2" : "#313944";
    const muted = dark ? "#8f99a7" : "#7e8794";
    const layout = sankeyLayoutFor(width);
    const center = "持仓盈亏";
    const centerAmountColor = netTotal >= 0 ? "#e5484d" : "#0aa77d";
    const nodeName = (item: PnlSankeyItem, side: "P" | "L") => `${side}:${item.market}:${item.code}`;
    // 宽屏两行（名称 / 金额），手机单行（名称 + 金额）：单行标签只有一半高，
    // ECharts 的 hideOverlap 就不会再成片隐藏小持仓的标签。
    const label = (item: PnlSankeyItem) => layout.wide
      ? `{name|${displayName(item)}}\n{amount|${compactMoney(item.pnl, currency)}}`
      : `{name|${displayName(item)}} {amount|${compactMoney(item.pnl, currency)}}`;
    const nodes = [
      ...profit.map((item) => ({ name: nodeName(item, "P"), depth: 0, itemStyle: { color: "#e5484d" }, label: { formatter: label(item), position: "left", rich: { name: { color: ink }, amount: { color: "rgba(229,72,77,.85)" } } } })),
      { name: center, depth: 1, itemStyle: { color: "#7567b9" }, label: layout.wide ? { color: centerAmountColor, fontWeight: 800, formatter: `{name|${center}}\n{amount|${compactMoney(netTotal, currency)}}`, rich: { name: { color: centerAmountColor, fontSize: 12, fontWeight: 800, lineHeight: 16 }, amount: { color: centerAmountColor, fontSize: 10, fontWeight: 700, lineHeight: 13 } } } : { show: false } },
      ...loss.map((item) => ({ name: nodeName(item, "L"), depth: 2, itemStyle: { color: "#0aa77d" }, label: { formatter: label(item), position: "right", rich: { name: { color: ink }, amount: { color: "rgba(10,167,125,.88)" } } } }))
    ];
    const links = [
      ...profit.map((item) => ({ source: nodeName(item, "P"), target: center, value: Math.max(.01, Math.abs(item.pnl)), stock: item, lineStyle: { color: "rgba(229,72,77,.42)" } })),
      ...loss.map((item) => ({ source: center, target: nodeName(item, "L"), value: Math.max(.01, Math.abs(item.pnl)), stock: item, lineStyle: { color: "rgba(10,167,125,.38)" } }))
    ];
    return {
      animationDuration: 450,
      tooltip: { trigger: "item", confine: true, backgroundColor: dark ? "#202630" : "#fff", borderColor: dark ? "rgba(255,255,255,.14)" : "#d9dee5", textStyle: { color: ink, fontSize: 12 }, formatter: (params: { data?: { stock?: PnlSankeyItem }; name?: string }) => {
        const item = params.data?.stock;
        if (!item) return `<b>${params.name || center}</b>`;
        const positive = item.pnl > 0;
        return `<b>${item.name} ${item.code}</b><br/><span style="color:${muted}">${marketLabel(item.market)}</span><br/><b style="color:${positive ? "#e5484d" : "#0aa77d"}">${positive ? "+" : "−"}${formatCurrency(convert(item.pnl), currency)}</b>`;
      } },
      series: [{
        type: "sankey",
        left: layout.sideMargin,
        right: layout.sideMargin,
        top: layout.wide ? 30 : 18,
        bottom: layout.wide ? 30 : 18,
        nodeWidth: layout.nodeWidth,
        nodeGap: layout.nodeGap,
        nodeAlign: "justify",
        draggable: false,
        layoutIterations: layout.wide ? 48 : 32,
        data: nodes,
        links,
        lineStyle: { curveness: .5, opacity: .55 },
        itemStyle: { borderWidth: 0, borderRadius: 3 },
        label: {
          color: ink,
          fontSize: layout.fontSize,
          fontWeight: 650,
          distance: layout.labelGap,
          lineHeight: layout.lineHeight,
          verticalAlign: "middle",
          overflow: "truncate",
          width: layout.labelWidth,
          rich: {
            name: { fontSize: layout.fontSize, fontWeight: 650, color: ink, lineHeight: layout.lineHeight },
            amount: { fontSize: layout.amountFontSize, fontWeight: 700, color: muted, lineHeight: layout.lineHeight }
          }
        },
        emphasis: { focus: "adjacency", lineStyle: { opacity: .95 } },
        labelLayout: { hideOverlap: true }
      }]
    };
  }

  useEffect(() => {
    if (!ref.current || empty) return;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    const dark = document.documentElement.classList.contains("dark");
    let appliedWidth = ref.current.clientWidth;
    chart.setOption(buildOption(dark, appliedWidth));
    const resize = new ResizeObserver(() => {
      if (!ref.current) return;
      const nextWidth = ref.current.clientWidth;
      chart.resize();
      // 标签列宽、字号、节点宽度都随宽度连续变化，宽度变动超过一个阈值才重算布局，
      // 避免布局抖动（键盘弹出、滚动条出现）时反复 setOption。
      if (Math.abs(nextWidth - appliedWidth) >= 24) {
        appliedWidth = nextWidth;
        chart.setOption(buildOption(dark, nextWidth), true);
      }
    });
    resize.observe(ref.current);
    return () => { resize.disconnect(); chart.dispose(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profit, loss, empty, currency, currencyRate]);

  async function shareImage() {
    if (empty || !chartRef.current) return;
    let logo = "";
    let text = "Fire";
    try {
      const res = await fetch("/api/settings/public");
      const data = await res.json();
      logo = data?.settings?.siteLogo ?? "";
      text = data?.settings?.logoText || "Fire";
    } catch {
      /* 品牌信息拉取失败时用默认值 */
    }
    const chart = chartRef.current;
    const wasDark = document.documentElement.classList.contains("dark");
    // 分享图跟随当前主题：深色模式黑底深色文字、浅色模式白底
    setShareDark(wasDark);
    await new Promise((r) => setTimeout(r, 80));
    const chartUrl = chart.getDataURL({ pixelRatio: 3, backgroundColor: wasDark ? "#16181d" : "#ffffff" });
    setBrand({ logo, text });
    setShareChartUrl(chartUrl);
    setSharing(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const img = shareImgRef.current;
    if (img) {
      try {
        await img.decode();
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (!shareCardRef.current) {
      setSharing(false);
      return;
    }
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(shareCardRef.current, {
        backgroundColor: wasDark ? "#16181d" : "#ffffff",
        scale: 3,
        useCORS: true,
        onclone: (doc) => {
          const card = doc.querySelector<HTMLElement>("[data-share-card]");
          if (card) {
            card.style.setProperty("-webkit-font-smoothing", "antialiased");
            card.style.textRendering = "geometricPrecision";
          }
        },
        logging: false
      });
      setPreviewUrl(canvas.toDataURL("image/png"));
    } finally {
      setSharing(false);
    }
  }

  function dataUrlToBlob(dataUrl: string): Blob {
    // 不依赖 fetch(data:...)，兼容 Safari 等对 data URL fetch 支持不完整的浏览器
    const comma = dataUrl.indexOf(",");
    const mime = /^data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] || "image/png";
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  async function copyImage(url: string) {
    let blob: Blob;
    try {
      blob = dataUrlToBlob(url);
    } catch {
      showToast("生成剪贴板数据失败，请重试");
      return;
    }
    // 1) 浏览器剪贴板 API（仅安全上下文可用）；抛错不阻塞，继续走服务端兜底
    if (window.isSecureContext && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        showToast("图片已复制，可直接粘贴分享");
        return;
      } catch {
        /* NotAllowedError（文档未聚焦 / 权限被拒）等：落到服务端兜底 */
      }
    }
    // 2) 局域网 http（非安全上下文）或浏览器 API 不可用时：服务端写入 Mac 系统剪贴板
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const res = await fetch("/api/clipboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || "复制失败");
      showToast("图片已复制，可直接在聊天窗口粘贴分享");
    } catch (err) {
      // 复制失败只提示，不触发下载；下载仅由「保存图片」触发
      const message = err instanceof Error ? err.message : "请使用「保存图片」";
      console.error("[sankey-copy]", message);
      showToast(`复制失败：${message}`);
    }
  }

  function saveImage(url: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = `持仓盈利图-${localDateKey()}.png`;
    link.click();
    showToast("图片已保存");
    setPreviewUrl(null);
  }

  return <section className="holdings-pnl-sankey-card holdings-pnl-sankey-wide">
    <header>
      <div><span className="holdings-pnl-sankey-dot is-mixed" /><h4>持仓盈利图</h4></div>
      <div className="holdings-pnl-header-actions">
        <button type="button" className="holdings-pnl-share-btn" onClick={() => void shareImage()} disabled={empty} title="导出分享图片">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>
          分享
        </button>
        <details ref={currencyMenuRef} className="holdings-pnl-currency-picker">
          <summary aria-label={`当前货币：${selectedCurrency.name}`} title="主要货币换算">
            <MarketIcon market={selectedCurrency.market} flag={selectedCurrency.flag} size={22} />
            <span>{selectedCurrency.code}</span>
            <svg viewBox="0 0 20 20" aria-hidden><path d="m6 8 4 4 4-4" /></svg>
          </summary>
          <div className="holdings-pnl-currency-menu">
            <p>主要货币换算</p>
            {MULTI_CURRENCIES.map((item) => {
              const active = item.code === currency;
              const available = item.code === "USD" || !!rates[item.code];
              return <button
                key={item.code}
                type="button"
                disabled={!available}
                className={active ? "is-active" : ""}
                onClick={() => {
                  setCurrency(item.code);
                  currencyMenuRef.current?.removeAttribute("open");
                }}
              >
                <MarketIcon market={item.market} flag={item.flag} size={22} />
                <span><strong>{item.name}</strong><small>{item.code}</small></span>
                {active && <svg viewBox="0 0 20 20" aria-hidden><path d="m5 10 3 3 7-7" /></svg>}
              </button>;
            })}
            <small>按最新可用汇率换算，仅供参考</small>
          </div>
        </details>
      </div>
    </header>
    <div className="holdings-pnl-sankey-summary" aria-label="持仓盈亏汇总">
      <div className={netTotal >= 0 ? "is-profit" : "is-loss"}>
        <span>总盈利</span>
        <strong>{netTotal >= 0 ? "+" : "−"}{formatCurrency(convert(netTotal), currency)}</strong>
      </div>
      <span className="holdings-pnl-sankey-equation">=</span>
      <div className="is-profit">
        <span>盈利总额</span>
        <strong>+{formatCurrency(convert(profitTotal), currency)}</strong>
      </div>
      <span className="holdings-pnl-sankey-equation">−</span>
      <div className="is-loss">
        <span>亏损总额</span>
        <strong>{formatCurrency(convert(lossTotal), currency)}</strong>
      </div>
    </div>
    {empty ? <div className="holdings-pnl-sankey-empty">暂无可计算的持仓盈亏数据</div> : <div ref={ref} className="holdings-pnl-sankey-canvas" style={{ "--sankey-canvas-height": `${sankeyCanvasHeight(Math.max(profit.length, loss.length))}px` } as CSSProperties} />}
    {sharing && (
      <div
        ref={shareCardRef}
        data-share-card
        aria-hidden
        style={{
          position: "fixed",
          left: -10000,
          top: 0,
          width: 720,
          background: "#a5a5bf",
          padding: "14px 16px 14px",
          zIndex: -10,
          WebkitFontSmoothing: "antialiased",
          textRendering: "geometricPrecision",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
        }}
      >
        {/* 头部：LOGO / 标题浮在薰衣草紫底上 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <img src={brand.logo || FALLBACK_LOGO} alt="" style={{ height: 28, width: brand.logo ? "auto" : 28 }} />
            <strong style={{ fontSize: 17, fontWeight: 800, color: "#2b2b33", letterSpacing: ".2px" }}>{brand.text}</strong>
          </span>
          <span style={{ textAlign: "right" }}>
            <strong style={{ display: "block", fontSize: 17, fontWeight: 800, color: "#2b2b33" }}>持仓盈利图</strong>
            <small style={{ fontSize: 11, fontWeight: 600, color: "#5a5a68" }}>{dateLabel}</small>
          </span>
        </div>
        {/* 内容块：独立卡片，白/深色，圆角 + 阴影（块装） */}
        <div style={{ background: shareDark ? "#16181d" : "#ffffff", borderRadius: 14, boxShadow: "0 8px 22px rgba(30,30,50,.12)", padding: "12px 16px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
            {[
              {
                label: "总盈利",
                value: `${netTotal >= 0 ? "+" : "−"}${formatCurrency(convert(netTotal), currency)}`,
                color: netTotal >= 0 ? "#e5484d" : "#0aa77d"
              },
              { label: "盈利总额", value: `+${formatCurrency(convert(profitTotal), currency)}`, color: "#e5484d" },
              { label: "亏损总额", value: formatCurrency(convert(lossTotal), currency), color: "#0aa77d" }
            ].map((box, index) => (
              <div key={box.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {index > 0 && <span style={{ fontSize: 15, fontWeight: 800, color: shareDark ? "#8f99a7" : "#98a0ab" }}>{index === 1 ? "=" : "−"}</span>}
                <div style={{ minWidth: 148, border: `1px solid ${shareDark ? "rgba(255,255,255,.12)" : "#e7eaef"}`, borderRadius: 12, background: shareDark ? "rgba(255,255,255,.055)" : "#f6f7f9", padding: "9px 12px", textAlign: "center" }}>
                  <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: shareDark ? "#8f99a7" : "#8a929e" }}>{box.label}</span>
                  <strong style={{ display: "block", marginTop: 3, fontSize: 16, fontWeight: 850, color: box.color, fontVariantNumeric: "tabular-nums" }}>{box.value}</strong>
                </div>
              </div>
            ))}
          </div>
          <img ref={shareImgRef} src={shareChartUrl} alt="" style={{ width: "100%", display: "block", marginTop: 14 }} />
        </div>
      </div>
    )}
    {previewUrl && (
      <AppModal title="持仓盈利图预览" onClose={() => setPreviewUrl(null)} size="lg">
        <img
          src={previewUrl}
          alt="持仓盈利图预览"
          className="max-h-[58vh] w-full rounded-2xl border border-edge bg-white object-contain dark:bg-[#16181d]"
        />
        <div className="mt-5 flex justify-end gap-2.5">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewUrl(null)}>关闭</button>
          <button type="button" className="btn btn-line btn-sm" onClick={() => void copyImage(previewUrl)}>复制图片</button>
          <button type="button" className="btn btn-brand btn-sm text-ink" onClick={() => saveImage(previewUrl)}>保存图片</button>
        </div>
      </AppModal>
    )}
  </section>;
}
