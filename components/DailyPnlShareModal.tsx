"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { showToast } from "@/lib/toast";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { usePersistedState } from "@/lib/usePersistedState";
import { getMarketBadge, isMarketBadgeVisible } from "@/lib/marketBadge";
import type { CurrencyCode } from "@/lib/currencyPrefs";
import { fmtNumberCompactZh, localDateKey } from "@/lib/format";

export interface DailyPnlShareItem {
  id: string;
  name: string;
  code: string;
  market: string;
  dayPnl: number;
  marketValue: number;
  cost: number;
  price: number;
  pnl: number;
}

interface Props {
  dayPnl: number;
  totalPnl: number;
  totalAsset: number;
  currency: CurrencyCode;
  items: DailyPnlShareItem[];
  initialProfile?: { name: string; avatar: string };
  onClose: () => void;
}

type ShareTab = "amount" | "holdings" | "allocation";

const PROFIT_TEMPLATES = Array.from({ length: 5 }, (_, index) => `/share/daily-pnl/profit/0${index + 1}.png`);
const LOSS_TEMPLATES = Array.from({ length: 5 }, (_, index) => `/share/daily-pnl/loss/0${index + 1}.png`);
const TAB_OPTIONS: Array<{ key: ShareTab; label: string }> = [
  { key: "amount", label: "盈亏金额" },
  { key: "holdings", label: "持仓列表" },
  { key: "allocation", label: "持仓占比" }
];

const templatePreloads = new Map<string, Promise<void>>();
export function preloadDailyPnlTemplates(positive: boolean) {
  const sources = positive ? PROFIT_TEMPLATES : LOSS_TEMPLATES;
  return Promise.all(sources.map((src) => {
    if (templatePreloads.has(src)) return templatePreloads.get(src)!;
    const promise = new Promise<void>((resolve) => {
      const image = new Image();
      image.onload = () => {
        image.decode().catch(() => {}).finally(() => resolve());
      };
      image.onerror = () => resolve();
      image.src = src;
    });
    templatePreloads.set(src, promise);
    return promise;
  }));
}

export function waitForDailyPnlTemplates() {
  return Promise.all(Array.from(templatePreloads.values()));
}

let html2canvasPromise: Promise<typeof import("html2canvas")> | null = null;
function loadHtml2canvas() {
  if (!html2canvasPromise) html2canvasPromise = import("html2canvas");
  return html2canvasPromise;
}

function formatAmount(value: number) {
  return fmtNumberCompactZh(Math.abs(value));
}

function formatPrice(value: number, market?: string) {
  const digits = market === "US" ? 3 : 2;
  return value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatDateTime(date: Date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function dataUrlToBlob(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  const mime = /^data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] || "image/png";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function TabIcon({ tab }: { tab: ShareTab }) {
  if (tab === "amount") return <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-8 w-8"><path d="M7 9h16a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h13" /><path d="M5 11h18a3 3 0 0 1 3 3v4h-7a3 3 0 0 1 0-6h7" /><circle cx="19" cy="15" r="1" fill="currentColor" stroke="none" /></svg>;
  if (tab === "holdings") return <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-8 w-8"><rect x="5" y="5" width="8" height="8" rx="1.5" /><rect x="19" y="5" width="8" height="8" rx="1.5" /><rect x="5" y="19" width="8" height="8" rx="1.5" /><path d="M19 20h8M19 25h8" /></svg>;
  return <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-8 w-8"><path d="M16 4a12 12 0 1 0 12 12H16V4Z" /><path d="M19 4.4A12 12 0 0 1 27.6 13H19V4.4Z" /></svg>;
}

function MoneyIcon() {
  // 单层 $ 圆徽：去掉嵌套 span 与 translate，浏览器与 html2canvas 导出（复制图片）的垂直对齐保持一致，
  // 避免复制出的图片里 $ 上下错位。
  return <span aria-hidden="true" className="inline-flex h-[19px] w-[19px] flex-none items-center justify-center rounded-full border-[1.5px] border-current text-[12px] font-semibold leading-none text-[#9aa1aa] dark:text-[#8993a1]">$</span>;
}

function ShareCardTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: "22px", textAlign: "center" }}><h3 style={{ margin: 0, fontSize: "22px", fontWeight: 700, lineHeight: "30px", color: "inherit" }}>{children}</h3><div data-share-title-bar style={{ width: "40px", height: "4px", margin: "4px auto 0", borderRadius: "999px", background: "linear-gradient(90deg, #6c7ff2 0%, #64c7b6 50%, #f1b451 100%)" }} /></div>;
}

export default function DailyPnlShareModal({ dayPnl, totalPnl, totalAsset, currency, items, initialProfile, onClose }: Props) {
  const { stockIcons } = useAssetIcons(["stock"]);
  const cardRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<ShareTab>("amount");
  const [selectedTemplate, setSelectedTemplate] = useState(0);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [openedAt] = useState(() => new Date());
  const [imagesReady, setImagesReady] = useState(false);
  const [profile, setProfile] = useState(() => ({
    name: initialProfile?.name || "我的投资记录",
    avatar: initialProfile?.avatar || ""
  }));
  const [cardSize, setCardSize] = usePersistedState("fire:daily-pnl-share-size", { width: 600, height: 700 });
  const [customTemplates, setCustomTemplates] = useState<Record<number, string>>({});
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const positive = dayPnl >= 0;
  const accent = positive ? "#ff4d00" : "#70c8b1";
  const templates = positive ? PROFIT_TEMPLATES : LOSS_TEMPLATES;
  const selectedImage = customTemplates[selectedTemplate] || templates[selectedTemplate] || templates[0];
  // 持仓列表按盈亏率降序排列（成本 ≤ 0 时无盈亏率，排到最末），全部列出，可视区固定约 7 行可滚动。
  const rankedItems = useMemo(() => [...items]
    .sort((a, b) => {
      const rateA = a.cost > 0 ? (a.price - a.cost) / a.cost : -Infinity;
      const rateB = b.cost > 0 ? (b.price - b.cost) / b.cost : -Infinity;
      return rateB - rateA || b.marketValue - a.marketValue || a.code.localeCompare(b.code);
    }), [items]);
  const allocationItems = useMemo(() => [...items].filter((item) => item.marketValue > 0).sort((a, b) => b.marketValue - a.marketValue).slice(0, 5), [items]);
  const allocationTotal = allocationItems.reduce((sum, item) => sum + item.marketValue, 0) || 1;
  const allocationColors = ["#6c7ff2", "#64c7b6", "#f1b451", "#f071a9", "#8d79c7"];
  const shareWidth = cardSize.width;
  const shareHeight = cardSize.height;
  const showTemplates = tab === "amount";
  const shareLayoutWidth = showTemplates ? shareWidth + 112 : shareWidth;
  const shareLayoutHeight = shareHeight + 56;
  const thumbSize = Math.max(56, Math.round((shareHeight * 3 / 4 - 5 * 8) / 6));

  useEffect(() => {
    setSelectedTemplate(0);
  }, [positive]);

  useEffect(() => {
    let cancelled = false;
    preloadDailyPnlTemplates(true);
    preloadDailyPnlTemplates(false);
    Promise.all(Array.from(templatePreloads.values())).then(() => {
      if (!cancelled) setImagesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const resize = () => setScale(Math.min(1, (window.innerHeight - 126) / shareLayoutHeight, (window.innerWidth - 76) / shareLayoutWidth));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [shareHeight]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", keydown);
    void loadHtml2canvas();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
    };
  }, [onClose]);

  const startCardResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = shareWidth;
    const startHeight = shareHeight;
    const currentScale = scale || 1;
    const baseFactor = startWidth / 600;
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - startX) / currentScale;
      const dy = (moveEvent.clientY - startY) / currentScale;
      const minFactor = Math.max(420 / 600, 520 / 700);
      const maxFactor = Math.min(760 / 600, 900 / 700);
      const factor = Math.max(minFactor, Math.min(maxFactor, baseFactor + (dx + dy) / (startWidth + startHeight)));
      setCardSize({ width: Math.round(600 * factor), height: Math.round(700 * factor) });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const handleTemplateUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const target = uploadTarget ?? templates.length;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setCustomTemplates((prev) => ({ ...prev, [target]: reader.result as string }));
        setSelectedTemplate(target);
      }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  async function renderCard() {
    if (!cardRef.current) throw new Error("分享卡尚未准备好");
    const card = cardRef.current;
    if (document.fonts?.ready) await document.fonts.ready;
    await Promise.all(Array.from(card.querySelectorAll("img")).map(async (image) => {
      if (!image.complete) await new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve(); });
      try { await image.decode(); } catch { /* 浏览器已完成加载时可直接继续 */ }
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const { default: html2canvas } = await loadHtml2canvas();
    return html2canvas(card, {
      backgroundColor: null,
      width: card.offsetWidth,
      height: card.offsetHeight,
      scale: 3,
      useCORS: true,
      logging: false,
      onclone: (clonedDoc, clonedElement) => {
        const svgNamespace = "http://www.w3.org/2000/svg";
        clonedElement.querySelectorAll<HTMLElement>("[data-share-title-bar]").forEach((bar) => {
          bar.style.marginTop = "10px";
        });
        const rows = Array.from(clonedElement.querySelectorAll<HTMLElement>("[data-share-market-badge-row]"));
        rows.forEach((row) => {
          const badgeSvg = row.querySelector<SVGSVGElement>("[data-share-market-badge]");
          const badgeRect = badgeSvg?.querySelector("rect");
          const badgeText = badgeSvg?.querySelector("text");
          const codeNode = row.querySelector<HTMLElement>("[data-share-market-code]");
          const label = badgeText?.textContent || "";
          const code = codeNode?.textContent || "";
          const width = Math.max(76, 42 + code.length * 7);
          const combined = clonedDoc.createElementNS(svgNamespace, "svg");
          combined.setAttribute("width", String(width));
          combined.setAttribute("height", "24");
          combined.setAttribute("viewBox", `0 0 ${width} 24`);
          combined.style.display = "block";
          combined.style.width = `${width}px`;
          combined.style.height = "24px";
          const rect = clonedDoc.createElementNS(svgNamespace, "rect");
          rect.setAttribute("x", "0");
          rect.setAttribute("y", "2");
          rect.setAttribute("width", "30");
          rect.setAttribute("height", "20");
          rect.setAttribute("rx", "4");
          rect.setAttribute("fill", badgeRect?.getAttribute("fill") || "#e5e7eb");
          const marketText = clonedDoc.createElementNS(svgNamespace, "text");
          marketText.setAttribute("x", "15");
          marketText.setAttribute("y", "12");
          marketText.setAttribute("text-anchor", "middle");
          marketText.setAttribute("dominant-baseline", "central");
          marketText.setAttribute("font-size", "10");
          marketText.setAttribute("font-weight", "600");
          marketText.setAttribute("fill", badgeText?.getAttribute("fill") || "#fff");
          marketText.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
          marketText.textContent = label;
          const codeText = clonedDoc.createElementNS(svgNamespace, "text");
          codeText.setAttribute("x", "38");
          codeText.setAttribute("y", "12");
          codeText.setAttribute("dominant-baseline", "central");
          codeText.setAttribute("font-size", "11");
          codeText.setAttribute("fill", "#9298a1");
          codeText.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
          codeText.textContent = code;
          combined.append(rect, marketText, codeText);
          row.replaceChildren(combined);
          row.style.display = "block";
          row.style.width = `${width}px`;
          row.style.height = "24px";
          row.style.marginTop = "6px";
          row.style.lineHeight = "24px";
          row.style.overflow = "visible";
        });
        const list = clonedElement.querySelector<HTMLElement>(".share-list-scroll");
        if (list) {
          list.style.maxHeight = "360px";
          list.style.height = "360px";
          list.style.overflow = "hidden";
          list.scrollTop = 0;
        }
        clonedElement.querySelectorAll<HTMLElement>("[data-share-holding-row]").forEach((row) => {
          row.style.height = "60px";
          row.style.minHeight = "60px";
          row.style.maxHeight = "60px";
          row.style.paddingTop = "4px";
          row.style.paddingBottom = "4px";
        });
        clonedElement.querySelectorAll<HTMLElement>("[data-share-stock-name]").forEach((name) => {
          name.style.height = "22px";
          name.style.lineHeight = "22px";
          name.style.overflow = "visible";
          name.style.textOverflow = "clip";
          name.style.whiteSpace = "nowrap";
        });
      }
    });
  }

  async function copyCard() {
    if (busy) return;
    setBusy("copy");
    showToast("正在生成图片…");
    try {
      const canvas = await renderCard();
      const blob = dataUrlToBlob(canvas.toDataURL("image/png"));
      if (window.isSecureContext && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          showToast("已复制图片");
          return;
        } catch { /* 局域网环境使用服务端剪贴板兜底 */ }
      }
      const image = canvas.toDataURL("image/png");
      const response = await fetch("/api/clipboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }) });
      if (!response.ok) throw new Error("复制失败，请改用保存图片");
      showToast("已复制图片");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "复制失败", "err");
    } finally {
      setBusy(null);
    }
  }

  async function saveCard() {
    if (busy) return;
    setBusy("save");
    try {
      const canvas = await renderCard();
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = `当日盈亏-${localDateKey()}.png`;
      link.click();
      showToast("分享图已保存");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败", "err");
    } finally {
      setBusy(null);
    }
  }

  const cardBody = tab === "amount" ? <>
    <ShareCardTitle>当日盈亏</ShareCardTitle>
    <div className="mt-[10px] text-center whitespace-nowrap tabular-nums" style={{ color: accent }}><span className="text-[54px] font-medium leading-none tracking-[-.035em]">{dayPnl < 0 ? "-" : "+"}{formatAmount(dayPnl)}</span><span className="ml-[9px] text-[27px] font-normal leading-none tracking-[-.01em]">{currency}</span></div>
    <div className="mx-[36px] mt-[30px] overflow-hidden bg-transparent">{imagesReady ? <img src={selectedImage} alt={positive ? "盈利分享模板" : "亏损分享模板"} className="block h-auto w-full max-w-full object-contain" loading="eager" decoding="sync" fetchPriority="high" /> : <div className="h-[390px] w-full animate-pulse rounded-[20px] bg-[#f0f2f5] dark:bg-white/10" />}</div>
  </> : tab === "holdings" ? <>
    <ShareCardTitle>股票持仓</ShareCardTitle>
    <div className="mx-[36px] mt-[22px] overflow-hidden rounded-[20px] border border-[#e8e9eb] dark:border-white/5">
      <div className="flex flex-none items-center gap-2.5 border-b border-[#eceef0] px-4 py-2.5 text-[13px] font-semibold text-[#8a919c] dark:border-white/5 dark:text-[#8f99a8]"><span className="w-[28px] flex-none text-center">序号</span><span className="flex min-w-0 flex-1 items-center gap-2.5"><span className="h-8 w-8 flex-none" /><span>名称/代码</span></span><span className="w-[56px] flex-none text-right">成本价</span><span className="w-[56px] flex-none text-right">现价</span><span className="w-[64px] flex-none text-right">盈亏率</span></div>
      <div className="share-list-scroll max-h-[364px]">{rankedItems.map((item, index) => {
        const icon = stockIcons[`${item.market.toUpperCase()}:${item.code.toUpperCase()}`];
        const badge = getMarketBadge(item.market, item.code);
        const showBadge = isMarketBadgeVisible();
        const rankColor = index === 0 ? "#f5a623" : index === 1 ? "#9aa3ad" : index === 2 ? "#c8864a" : "#9298a1";
        const rankSize = index === 0 ? "text-[24px] font-bold" : index === 1 ? "text-[20px] font-bold" : index === 2 ? "text-[17px] font-semibold" : "text-[14px] font-semibold";
        const rate = item.cost > 0 ? ((item.price - item.cost) / item.cost) * 100 : null;
        const rateColor = rate == null ? "#9298a1" : rate >= 0 ? "#ef5158" : "#70bfa8";
        return <div key={item.id} data-share-holding-row className="flex min-h-[52px] items-center gap-2.5 border-b border-[#eceef0] px-4 py-1.5 last:border-b-0 dark:border-white/5"><span className={`w-[28px] flex-none text-center tabular-nums leading-none ${rankSize}`} style={{ color: rankColor }}>{index + 1}</span><span className="flex min-w-0 flex-1 items-center gap-2.5"><i className="flex h-8 w-8 flex-none items-center justify-center overflow-hidden rounded-full bg-[#f0f2f5] text-[12px] font-semibold not-italic text-[#707783] dark:bg-white/8 dark:text-white/70">{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : (item.name || item.code).slice(0, 1)}</i><span className="min-w-0 flex-1"><div data-share-stock-name style={{ fontSize: "14px", lineHeight: "18px", fontWeight: 700, wordBreak: "break-word", whiteSpace: "normal" }}>{item.name}</div><div data-share-market-badge-row style={{ display: "grid", gridTemplateColumns: showBadge ? "30px minmax(0, 1fr)" : "minmax(0, 1fr)", alignItems: "center", columnGap: "8px", height: "18px", marginTop: "4px", lineHeight: "18px" }}>{showBadge && <svg data-share-market-badge width="30" height="18" viewBox="0 0 30 18" style={{ display: "block", width: "30px", height: "18px" }} aria-hidden="true"><rect width="30" height="18" rx="4" fill={badge.bg} /><text x="15" y="9" textAnchor="middle" dominantBaseline="central" fontSize="10" fontWeight="600" fill={badge.fg} fontFamily="system-ui, -apple-system, sans-serif">{badge.label}</text></svg>}<span data-share-market-code style={{ display: "block", margin: 0, fontSize: "11px", lineHeight: "18px", color: "#9298a1", whiteSpace: "nowrap" }}>{item.code}</span></div></span></span><span className="w-[56px] flex-none text-right text-[13px] tabular-nums">{formatPrice(item.cost, item.market)}</span><span className="w-[56px] flex-none text-right text-[13px] tabular-nums">{formatPrice(item.price, item.market)}</span><strong className="w-[64px] flex-none text-right text-[13px] tabular-nums" style={{ color: rateColor }}>{rate == null ? "—" : `${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`}</strong></div>;
      })}</div>
    </div>
    <div className="mx-[36px] mt-[22px] flex items-center justify-between rounded-[16px] bg-[#f7f8f9] px-6 py-4 dark:bg-[#10151f]"><span className="text-[14px] text-[#858c96]">持仓盈利</span><strong className="text-[22px] tabular-nums" style={{ color: totalPnl >= 0 ? "#ef5158" : "#70bfa8" }}>{totalPnl >= 0 ? "+" : "-"}{formatAmount(totalPnl)} {currency}</strong></div>
  </> : <>
    <ShareCardTitle>持仓分布</ShareCardTitle>
    <div className="mx-[36px] mt-[24px] flex items-center gap-8 rounded-[22px] bg-[#f7f8f9] px-7 py-7 dark:bg-[#10151f]"><div className="relative h-[190px] w-[190px] flex-none rounded-full" style={{ background: `conic-gradient(${allocationItems.map((item, index) => `${allocationColors[index]} ${allocationItems.slice(0, index).reduce((sum, row) => sum + row.marketValue / allocationTotal * 100, 0)}% ${allocationItems.slice(0, index + 1).reduce((sum, row) => sum + row.marketValue / allocationTotal * 100, 0)}%`).join(",")})` }}><i className="absolute inset-[35px] rounded-full bg-white dark:bg-[#151a26]" /><span className="absolute inset-0 flex flex-col items-center justify-center"><b className="text-[23px]">{allocationItems.length}</b><small className="text-[12px] text-[#8d949e]">项持仓</small></span></div><div className="min-w-0 flex-1 space-y-4">{allocationItems.map((item, index) => <div key={item.id} className="flex items-center justify-between gap-3 text-[15px]"><span className="flex min-w-0 items-center gap-2.5"><i className="h-3.5 w-3.5 flex-none rounded-full" style={{ background: allocationColors[index] }} /><b className="truncate">{item.name || item.code}</b></span><strong>{(item.marketValue / allocationTotal * 100).toFixed(1)}%</strong></div>)}</div></div>
    <div className="mx-[36px] mt-[22px] rounded-[20px] border border-[#e8e9eb] px-6 py-5 dark:border-white/10"><div className="flex items-center justify-between"><span className="text-[14px] text-[#858c96]">持仓市值</span><strong className="text-[22px] tabular-nums">{formatAmount(totalAsset)} {currency}</strong></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-[#eceef1] dark:bg-white/10"><i className="block h-full rounded-full bg-gradient-to-r from-[#6c7ff2] via-[#64c7b6] to-[#f1b451]" style={{ width: "100%" }} /></div></div>
  </>;

  if (typeof document === "undefined") return null;
  return createPortal(<div className="fixed inset-0 z-[10000] overflow-hidden bg-[#f7f8fa] text-[#151922] dark:bg-[#0a0e19] dark:text-white" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="mx-auto flex h-full w-full max-w-[860px] flex-col items-center justify-center px-6 py-5">
      <div className="relative mx-auto mb-4 flex w-full flex-none items-end justify-center" style={{ maxWidth: shareLayoutWidth }}>
        <div className="mr-[130px] flex items-end gap-5">{TAB_OPTIONS.map((option) => <button key={option.key} type="button" onClick={() => setTab(option.key)} className={`group relative flex min-w-[90px] flex-col items-center gap-1.5 pb-2 transition-colors ${tab === option.key ? "text-[#151922] dark:text-white" : "text-[#8a919c] hover:text-[#4f5661] dark:text-white/48 dark:hover:text-white/80"}`}><TabIcon tab={option.key} /><span className="text-[14px] font-semibold tracking-[.06em]">{option.label}</span>{tab === option.key && <i className="absolute bottom-0 h-[2px] w-8 rounded-full bg-[#151922] dark:bg-white" />}</button>)}</div>
      </div>
      <div className="flex flex-none items-center justify-center">
        <div className="relative" style={{ width: shareWidth * scale, height: shareLayoutHeight * scale }}>
          <button type="button" onClick={onClose} title="关闭" style={{ left: shareWidth * scale - 40, top: -44 }} className="absolute z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white/85 text-[#58606d] shadow-[0_8px_24px_rgba(0,0,0,.16)] backdrop-blur transition-all hover:scale-105 hover:bg-white hover:text-[#151922] dark:border-white/18 dark:bg-[#252b35]/90 dark:text-white/75 dark:hover:bg-[#303744] dark:hover:text-white" aria-label="关闭分享"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
          <div className="relative flex origin-top-left gap-[16px]" style={{ width: shareLayoutWidth, height: shareLayoutHeight, transform: `scale(${scale})` }}>
            <div ref={cardRef} data-daily-pnl-share-card className="relative flex-none overflow-hidden rounded-[42px] !bg-white text-[#151922] shadow-[0_22px_70px_rgba(0,0,0,.32)] dark:!bg-[#151a26] dark:text-[#f3f4f6]" style={{ width: shareWidth, height: shareHeight }}>
              <div className="origin-top-left" style={{ width: 600, height: 700, transform: `scale(${shareWidth / 600}, ${shareHeight / 700})` }}>
                <div className="px-[36px] pt-[30px]"><div className="flex min-w-0 items-center gap-4"><div className="flex h-[50px] w-[50px] flex-none items-center justify-center overflow-hidden rounded-full bg-[#edf0f2] text-[21px] font-bold dark:bg-[#252c38]">{profile.avatar ? <img src={profile.avatar} alt="我的头像" className="h-full w-full object-cover" /> : profile.name.slice(0, 1)}</div><div className="min-w-0 flex-1"><strong className="block whitespace-normal break-words text-[25px] font-semibold leading-[1.16] tracking-[-.02em] text-[#151922] dark:text-[#f3f4f6]">{profile.name}</strong><span className="mt-1 block text-[14px] font-normal text-[#949aa2] dark:text-[#8f99a8]">{formatDateTime(openedAt)}</span></div></div></div>
                {cardBody}
              </div>
            </div>
            <div onPointerDown={startCardResize} className="absolute z-20 flex h-8 w-8 cursor-nwse-resize items-center justify-center rounded-full bg-white/10 text-white/55 backdrop-blur transition-colors hover:bg-white/20 hover:text-white" style={{ left: shareWidth - 16, top: shareHeight - 16 }} title="拖拽调整卡片大小" aria-label="拖拽调整卡片大小">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4"><path d="M6 14 14 6M9 14l5-5M12 14l2-2" /></svg>
            </div>
            {showTemplates && <div className="flex h-full w-[96px] flex-none flex-col justify-start">
              <input ref={templateInputRef} type="file" accept="image/*" onChange={handleTemplateUpload} className="hidden" />
              <div className="flex flex-col gap-[8px]">
                {Array.from({ length: 6 }).map((_, index) => {
                  const src = index < templates.length ? (customTemplates[index] || templates[index]) : customTemplates[index] || "";
                  const active = selectedTemplate === index;
                  return <button key={`${positive}-${index}`} type="button" onClick={() => setSelectedTemplate(index)} style={{ width: thumbSize, height: thumbSize }} className={`group relative overflow-hidden rounded-[10px] border-[2px] bg-white/6 transition-all ${active ? "border-white shadow-[0_0_0_3px_rgba(255,255,255,.16)]" : "border-white/12 opacity-60 hover:opacity-80"}`} aria-label={index < templates.length ? `选择模板 ${index + 1}` : "上传自定义模板"}>
                    {src ? <img src={src} alt="" className={`absolute left-1/2 top-1/2 h-full w-full max-w-none -translate-x-1/2 -translate-y-1/2 scale-[1.28] object-cover transition-[filter] ${active ? "grayscale-0" : "grayscale"}`} loading="eager" decoding="sync" /> : <span className="flex h-full w-full items-center justify-center text-white/55"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6"><path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" /><circle cx="12" cy="13" r="3.5" /></svg></span>}
                    <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); setUploadTarget(index); templateInputRef.current?.click(); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setUploadTarget(index); templateInputRef.current?.click(); } }} title="上传自定义模板" aria-label={`上传模板 ${index + 1}`} className="absolute left-1/2 top-1/2 z-10 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-all duration-200 hover:scale-110 hover:bg-black/75 group-hover:opacity-100">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" /></svg>
                    </span>
                  </button>;
                })}
              </div>
            </div>}
            <div className="absolute z-30 flex items-center gap-2 rounded-full border border-white/35 bg-white/40 px-2.5 py-2 text-[#151922] shadow-[0_14px_36px_rgba(0,0,0,.12)] backdrop-blur-md dark:bg-white/10 dark:text-white" style={{ left: shareWidth / 2, top: shareHeight + 12, transform: "translateX(-50%)" }}>
              <button type="button" onClick={() => void copyCard()} disabled={Boolean(busy)} title={busy === "copy" ? "正在生成" : "复制分享图"} aria-label="复制分享图" className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-[#151922]/80 transition-all hover:bg-white/70 hover:text-[#151922] disabled:opacity-50 dark:text-white/85 dark:hover:bg-white/10 dark:hover:text-white"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>复制图片</button>
              <button type="button" onClick={() => void saveCard()} disabled={Boolean(busy)} title={busy === "save" ? "正在生成" : "保存分享图"} aria-label="保存分享图" className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-[#151922]/80 transition-all hover:bg-white/70 hover:text-[#151922] disabled:opacity-50 dark:text-white/85 dark:hover:bg-white/10 dark:hover:text-white"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></svg>保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>, document.body);
}
