"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { showToast } from "@/lib/toast";
import { useRates, usdCap, fmtUsd } from "@/lib/useRates";
import Pagination from "@/components/Pagination";
import MarketIcon from "@/components/MarketIcon";
import DeleteIcon from "@/components/DeleteIcon";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { appConfirm } from "@/lib/appDialog";

interface LibAsset {
  id: string;
  type: string;
  market: string;
  code: string;
  name: string;
  url: string;
  board: string;
  marketCap: number;
}

interface LibPage {
  items: LibAsset[];
  page: number;
  pageSize: number;
  total: number;
  totalAll: number;
  counts: Record<string, number>;
  markets: string[];
}
interface FinancialAttachment { id: string; market: string; exchange: string; companyCode: string; companyName: string; fiscalYear: number; fiscalPeriod: string; reportType: string; fileKind: string; fileName: string; fileUrl: string; fileSize: number; }

/** 财报分类：年报 / 半年报 / 单季报。按 fiscalPeriod + reportType 推导。 */
function reportCategory(file: Pick<FinancialAttachment, "fiscalPeriod" | "reportType">): string {
  const period = (file.fiscalPeriod || "").trim().toUpperCase();
  if (/^FY$|^Q4$/.test(period) && /年|年度|annual/i.test(file.reportType || "")) return "年报";
  if (/^FY$|^Y$/.test(period)) return "年报";
  if (/^(H1|H2|S1|S2|H)$/.test(period)) return "半年报";
  if (/^(Q1|Q2|Q3|Q4|H1)$/.test(period)) return /半年/.test(file.reportType || "") ? "半年报" : "单季报";
  const reportType = (file.reportType || "").trim();
  if (/年|annual/i.test(reportType)) return "年报";
  if (/半年/.test(reportType)) return "半年报";
  if (/季/.test(reportType)) return "单季报";
  return file.fiscalPeriod || "其他";
}

/** 报告类型排序权重：年报 > 半年报 > 单季报 */
function reportCategoryRank(category: string): number {
  if (category === "年报") return 0;
  if (category === "半年报") return 1;
  if (category === "单季报") return 2;
  return 3;
}

/** 报告类型 → 稳定数字码（用于 URL：年报=01、半年报=02、单季报=03，避免中文/长名撑爆 query） */
function reportCategoryCode(category: string): string {
  if (category === "年报") return "01";
  if (category === "半年报") return "02";
  if (category === "单季报") return "03";
  return category || "";
}

/** 报告类型码 → 显示名（URL 解码回中文） */
function reportCategoryName(code: string): string {
  if (code === "01") return "年报";
  if (code === "02") return "半年报";
  if (code === "03") return "单季报";
  return code || "";
}

/** 分页缓存：秒出首帧 + 预取后续页。键 = 分类|市场|搜索|排序，值 = { at, page, data }。 */
const LIB_CACHE_PREFIX = "fire:lib-page:";
const LIB_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
function libCacheKey(type: string, market: string, q: string, sort: string, page: number) {
  return `${LIB_CACHE_PREFIX}${type}|${market}|${q || "_"}|${sort}|${page}`;
}
function readLibCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (!parsed || !parsed.data) return null;
    if (Date.now() - parsed.at > LIB_CACHE_TTL) return null; // 过期视为无缓存
    return parsed.data;
  } catch {
    return null;
  }
}
function writeLibCache<T>(key: string, data: T) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* 忽略存储失败 */
  }
}

/** 财报文件列表缓存：秒出首帧 + 后台刷新，避免每次进财报文件 tab 都闪「正在读取」。 */
const FINREPORT_CACHE_KEY = "fire:finreports:v1";
const FINREPORT_CACHE_TTL = 5 * 60 * 1000;
function readFinReportCache(): FinancialAttachment[] | null {
  try {
    const raw = localStorage.getItem(FINREPORT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: FinancialAttachment[] };
    if (!parsed || !Array.isArray(parsed.data)) return null;
    if (Date.now() - parsed.at > FINREPORT_CACHE_TTL) return null;
    return parsed.data;
  } catch { return null; }
}
function writeFinReportCache(data: FinancialAttachment[]) {
  try { localStorage.setItem(FINREPORT_CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* 忽略 */ }
}

export function FinancialAttachments({ standalone }: { standalone?: boolean }) {
  const { stockIcons, marketIcons, assets } = useAssetIcons(["stock", "market"], { fullCatalog: true });
  // SSR 首帧统一为加载态；挂载前恢复本地缓存，避免水合不一致及可见闪烁。
  const [cachedFiles, setCachedFiles] = useState<FinancialAttachment[] | null>(null);
  const [files, setFiles] = useState<FinancialAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [urlReady, setUrlReady] = useState(false);
  const [error, setError] = useState("");
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // 类网盘文件夹导航：全部 → 市场 → 交易所 → 股票 → 年 → 报告类型；路径持久化到 ?view= 防止刷新重置。
  // 主流存储网站做法：URL 用稳定代码（公司 code / 报告类型英文码），显示时才映射为名称，避免中文长名撑爆 query。
  const [view, setView] = useState<{ market?: string; exchange?: string; companyCode?: string; year?: number; category?: string }>({});
  useLayoutEffect(() => {
    const cached = readFinReportCache();
    setCachedFiles(cached);
    if (cached) { setFiles(cached); setLoading(false); }
    const v = new URLSearchParams(window.location.search).get("view");
    if (v) {
      const [market, exchange, companyCode, year, category] = v.split("/");
      setView({ market: market || undefined, exchange: exchange ? decodeURIComponent(exchange) : undefined, companyCode: companyCode ? decodeURIComponent(companyCode) : undefined, year: year ? Number(year) : undefined, category: category ? reportCategoryName(decodeURIComponent(category)) : undefined });
    }
    setUrlReady(true);
  }, []);
  useEffect(() => {
    if (!urlReady) return;
    const url = new URL(window.location.href);
    const parts: string[] = [];
    if (view.market) parts.push(view.market);
    if (view.exchange) parts.push(view.exchange);
    if (view.companyCode) parts.push(view.companyCode);
    if (view.year) parts.push(String(view.year));
    if (view.category) parts.push(reportCategoryCode(view.category));
    // 手动拼 query 保留可读的 "/"（URLSearchParams 会把值里的 "/" 编码成 %2F）
    const searchParts: string[] = [];
    const curCategory = url.searchParams.get("category");
    if (curCategory) searchParts.push(`category=${encodeURIComponent(curCategory)}`);
    if (parts.length) searchParts.push(`view=${parts.map((p) => encodeURIComponent(p)).join("/")}`);
    url.search = searchParts.join("&");
    window.history.replaceState({}, "", url.toString());
  }, [view, urlReady]);
  const load = useCallback(() => {
    if (!cachedFiles) setLoading(true); // 有缓存则不闪加载态，后台刷新
    setError("");
    fetch("/api/v1/financial-reports")
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "财报文件加载失败");
        const data = Array.isArray(body?.data) ? body.data : [];
        setFiles(data);
        writeFinReportCache(data);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "财报文件加载失败"))
      .finally(() => setLoading(false));
  }, [cachedFiles]);
  useEffect(() => { if (urlReady) load(); }, [load, urlReady]);

  // 层层下钻的待展示集合
  const byMarket = view.market ? files.filter((f) => f.market === view.market) : null;
  const byExchange = view.market && view.exchange ? (byMarket || []).filter((f) => f.exchange === view.exchange) : null;
  const byCompany = view.market && view.exchange && view.companyCode ? (byExchange || []).filter((f) => f.companyCode === view.companyCode) : null;
  const byYear = view.year ? (byCompany || []).filter((f) => f.fiscalYear === view.year) : null;
  const rows = view.category ? (byYear || []).filter((f) => reportCategory(f) === view.category) : null;

  const remove = async (file: FinancialAttachment) => { if (!await appConfirm(`确定删除「${file.fileName}」吗？`, { title: "删除附件", danger: true })) return; const response = await fetch(`/api/v1/financial-reports/${encodeURIComponent(file.id)}`, { method: "DELETE" }); if (response.ok) { showToast("财报附件已删除"); load(); } else showToast("删除失败", "err"); };

  /** 上传市场/指数自定义图标（folder=market，更新素材库 market 图标，全局生效） */
  const uploadMarketIcon = async (marketKey: string, file: File) => {
    try {
      const fd = new FormData();
      fd.append("kind", "asset");
      fd.append("folder", "market");
      fd.append("name", marketLabel(marketKey));
      fd.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upData = await up.json().catch(() => null);
      if (!up.ok || !upData?.url) throw new Error(upData?.error || "上传失败");
      // 更新素材库 market 图标记录
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "market", market: marketKey, code: marketKey, name: marketLabel(marketKey), url: upData.url })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      showToast(`${marketLabel(marketKey)} 图标已更新，全局生效`);
      window.dispatchEvent(new Event("fire:assets-updated"));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
    }
  };

  /** 上传交易所/指数自定义图标：以该交易所自家公司股票图标（如 NDAQ）落库为 type=stock，
   *  素材库 stockIcons[市场:代码] 全局生效（交易所层 iconUrl 正是按 市场:EXCHANGE_ICON_CODE[e] 取图）。 */
  const uploadExchangeIcon = async (market: string, exchange: string, file: File) => {
    const code = EXCHANGE_ICON_CODE[exchange] || "";
    if (!code) { showToast(`${exchange} 暂无对应代码，暂不支持自定义图标`, "err"); return; }
    const name = exchange;
    try {
      const fd = new FormData();
      fd.append("kind", "asset");
      fd.append("folder", "stock");
      fd.append("market", market);
      fd.append("code", code);
      fd.append("name", name);
      fd.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upData = await up.json().catch(() => null);
      if (!up.ok || !upData?.url) throw new Error(upData?.error || "上传失败");
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stock", market, code, name, url: upData.url })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      showToast(`${name} 图标已更新，全局生效`);
      window.dispatchEvent(new Event("fire:assets-updated"));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
    }
  };

  const marketLabel = (m: string) => MARKET_LABEL[m] || m;
  // 股票代码 → 中文名称（素材库 stock 行，如 AAPL→苹果、NVDA→英伟达），财报公司层主显示中文名
  const stockNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    assets.forEach((a) => { if (a.type === "stock" && a.code) m[a.code.toUpperCase()] = a.name; });
    return m;
  }, [assets]);
  const companyZhName = (code: string, fallback: string) => stockNameMap[code.toUpperCase()] || fallback;
  // 面包屑
  const crumbs: { label: string; go: () => void; active: boolean }[] = [
    { label: "全部", go: () => setView({}), active: !view.market },
  ];
  if (view.market) crumbs.push({ label: marketLabel(view.market), go: () => setView({ market: view.market }), active: !!view.market && !view.exchange });
  if (view.exchange) crumbs.push({ label: view.exchange, go: () => setView({ market: view.market }), active: !!view.exchange && !view.companyCode });
  if (view.companyCode) {
    const company = (byExchange || byMarket || []).find((f) => f.companyCode === view.companyCode);
    crumbs.push({ label: company?.companyName || view.companyCode, go: () => setView({ market: view.market, exchange: view.exchange }), active: !view.year });
  }
  if (view.year) crumbs.push({ label: `${view.year} 财年`, go: () => setView({ market: view.market, exchange: view.exchange, companyCode: view.companyCode }), active: !view.category });
  if (view.category) crumbs.push({ label: view.category, go: () => setView({ market: view.market, exchange: view.exchange, companyCode: view.companyCode, year: view.year }), active: true });

  const folderCard = (label: string, sub: string, onClick: () => void, icon: "folder" | "year" | "type", iconUrl?: string, uploadableKey?: string, onUpload?: (file: File) => void) => (
    <button key={label} type="button" onClick={onClick} className="group relative flex items-center gap-3 rounded-[12px] border border-edge bg-white px-3.5 py-3 text-left shadow-card transition-all duration-200 hover:-translate-y-px hover:border-edge-strong hover:shadow-md active:scale-[.98] dark:bg-[#1c222d] dark:border-white/10">
      <span className="relative flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded-full bg-transparent text-brand-deep">
        {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-cover" /> : icon === "folder" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg> : icon === "year" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></svg>}
        {uploadableKey && onUpload && (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
            <span
              role="button"
              tabIndex={0}
              title="上传自定义图标"
              aria-label={`上传 ${label} 图标`}
              onClick={(e) => { e.stopPropagation(); fileRefs.current[`upload:${uploadableKey}`]?.click(); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRefs.current[`upload:${uploadableKey}`]?.click(); } }}
              className="grid h-6 w-6 place-items-center text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3" /></svg>
            </span>
            <input ref={(el) => { fileRefs.current[`upload:${uploadableKey}`] = el; }} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{label}</span>
        <span className="block truncate text-[11px] text-faint">{sub}</span>
      </span>
    </button>
  );

  // 当前视图：文件夹网格 or 文件列表
  let content: React.ReactNode = null;
  if (loading) {
    content = <div className="library-assets-status"><span /><span /><span /><small>正在读取财报文件</small></div>;
  } else if (error) {
    content = <div className="library-assets-error"><strong>财报文件加载失败</strong><span>{error}</span><button type="button" onClick={load}>重新加载</button></div>;
  } else if (!view.market) {
    const markets = [...new Set(files.map((f) => f.market))].sort((a, b) => MARKET_ORDER.indexOf(a) - MARKET_ORDER.indexOf(b));
    content = markets.length ? <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{markets.map((m) => { const n = files.filter((f) => f.market === m).length; const iconUrl = marketIcons[m.toUpperCase()]; return folderCard(marketLabel(m), `${n} 份财报`, () => setView({ market: m }), "folder", iconUrl, m, (f) => uploadMarketIcon(m, f)); })}</div> : <div className="card py-16 text-center text-sm text-faint">暂无财报附件</div>;
  } else if (!view.exchange) {
    const exchanges = [...new Set((byMarket || []).map((f) => f.exchange).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    content = exchanges.length ? <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{exchanges.map((e) => { const n = (byMarket || []).filter((f) => f.exchange === e).length; const iconCode = EXCHANGE_ICON_CODE[e] || ""; const iconUrl = iconCode ? stockIcons[`${view.market}:${iconCode}`.toUpperCase()] : undefined; return folderCard(e, `${n} 份财报`, () => setView({ market: view.market, exchange: e }), "folder", iconUrl, e, (f) => uploadExchangeIcon(view.market!, e, f)); })}</div> : <div className="card py-16 text-center text-sm text-faint">该市场暂无财报</div>;
  } else if (!view.companyCode) {
    const companies = [...new Set((byExchange || []).map((f) => f.companyCode))].sort((a, b) => a.localeCompare(b));
    content = companies.length ? <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{companies.map((code) => { const one = (byExchange || []).find((f) => f.companyCode === code); const iconUrl = one ? stockIcons[`${one.market}:${one.companyCode}`.toUpperCase()] : undefined; return folderCard(companyZhName(code, one?.companyName || code), code, () => setView({ market: view.market, exchange: view.exchange, companyCode: code }), "folder", iconUrl); })}</div> : <div className="card py-16 text-center text-sm text-faint">该交易所暂无财报</div>;
  } else if (!view.year) {
    const years = [...new Set((byCompany || []).map((f) => f.fiscalYear))].sort((a, b) => b - a);
    content = years.length ? <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{years.map((y) => { const n = (byCompany || []).filter((f) => f.fiscalYear === y).length; return folderCard(`${y} 财年`, `${n} 份`, () => setView({ market: view.market, exchange: view.exchange, companyCode: view.companyCode, year: y }), "year"); })}</div> : <div className="card py-16 text-center text-sm text-faint">该股票暂无财报</div>;
  } else if (!view.category) {
    const categories = [...new Set((byYear || []).map(reportCategory))].sort((a, b) => reportCategoryRank(a) - reportCategoryRank(b));
    content = categories.length ? <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{categories.map((cat) => { const n = (byYear || []).filter((f) => reportCategory(f) === cat).length; return folderCard(cat, `${n} 份`, () => setView({ market: view.market, exchange: view.exchange, companyCode: view.companyCode, year: view.year, category: cat }), "type"); })}</div> : <div className="card py-16 text-center text-sm text-faint">该年份暂无财报</div>;
  } else {
    content = (rows || []).length ? <div className="overflow-x-auto rounded-[14px] border border-edge bg-white shadow-card dark:bg-[#16181d]"><table className="w-full min-w-[560px] text-xs"><thead><tr className="bg-[#f6f7f9] text-[11px] font-semibold text-muted dark:bg-white/5"><th className="px-4 py-2 text-left">类型</th><th className="px-4 py-2 text-left">文件</th><th className="px-4 py-2 text-right">大小</th><th className="px-4 py-2 text-right">操作</th></tr></thead><tbody>{(rows || []).map((file) => <tr key={file.id} className="border-t border-edge"><td className="px-4 py-2.5 font-semibold text-brand-deep">{file.fileKind === "original" ? "PDF 原件" : file.fileKind === "parsed" ? "JSON 数据" : file.fileKind === "filing" ? "SEC 文件" : "CSV 导出"}</td><td className="px-4 py-2.5"><a href={file.fileUrl} target="_blank" rel="noreferrer" className="text-ink font-semibold hover:underline">{file.fiscalPeriod} · {file.fileName}</a></td><td className="px-4 py-2.5 text-right tabular-nums text-muted">{(file.fileSize / 1024 / 1024).toFixed(2)} MB</td><td className="px-4 py-2.5 text-right"><button type="button" onClick={() => remove(file)} className="text-up hover:underline">删除</button></td></tr>)}</tbody></table></div> : <div className="card py-16 text-center text-sm text-faint">该报告类型暂无财报</div>;
  }

  return <div className="flex flex-col gap-4">
    {standalone && (
      <nav className="flex items-center gap-1.5 overflow-x-auto text-xs" aria-label="财报文件路径">
        {crumbs.map((c, i) => (
          <span key={i} className="flex flex-none items-center gap-1.5">
            {i > 0 && <span className="text-faint">/</span>}
            <button type="button" onClick={c.go} className={`rounded-md px-2 py-1 font-semibold transition-colors ${c.active ? "text-ink" : "text-muted hover:bg-brand-hover hover:text-ink"}`}>{c.label}</button>
          </span>
        ))}
      </nav>
    )}
    {content}
  </div>;
}

const CATS = [
  { key: "stock", label: "股票" },
  { key: "crypto", label: "加密货币" },
  { key: "metal", label: "贵金属" },
  { key: "market", label: "市场" }
] as const;

const MARKET_ORDER = ["US", "HK", "CN", "JP", "KR"];
const MARKET_LABEL: Record<string, string> = { US: "美股", HK: "港股", CN: "A股", JP: "日股", KR: "韩股" };
/** 交易所 → 该交易所自家公司在素材库的图标代码（复用素材库股票图标），无则市场图标兜底 */
const EXCHANGE_ICON_CODE: Record<string, string> = {
  NASDAQ: "NDAQ",
  NYSE: "ICE",
  AMEX: "CME",
  BSE: "",
  HKEX: "00388",
  SSE: "",
  SZSE: ""
};
export default function LibraryAttachmentsView() {
  const rates = useRates();
  const [data, setData] = useState<LibPage | null>(null);
  const [cat, setCat] = useState<(typeof CATS)[number]["key"]>("stock");
  const [market, setMarket] = useState("ALL");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [preview, setPreview] = useState<LibAsset | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement | null>(null);
  const [page, setPage] = useState(1);
  const [capSort, setCapSort] = useState<"desc" | "asc">("desc");
  const PAGE_SIZE = 10;

  // 首帧秒出：进入/切分类/翻页时，若 localStorage 有缓存先立即渲染，再后台刷新
  const cachedPageRef = useRef<string | null>(null);
  const cacheKey = libCacheKey(cat, market, debouncedSearch, capSort, page);
  useEffect(() => {
    if (cachedPageRef.current === cacheKey) return;
    const cached = readLibCache<LibPage>(cacheKey);
    if (cached) {
      setData(cached);
      setLoadError("");
      setLoading(false);
    }
    cachedPageRef.current = cacheKey;
  }, [cacheKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 260);
    return () => window.clearTimeout(timer);
  }, [search]);

  const resetPage = useCallback(() => setPage(1), []);
  useEffect(() => resetPage(), [cat, market, debouncedSearch, resetPage]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      paged: "1",
      type: cat,
      market,
      q: debouncedSearch,
      sort: capSort === "desc" ? "cap_desc" : "cap_asc",
      page: String(page),
      pageSize: String(PAGE_SIZE)
    });
    // 有当前页缓存时保持显示缓存（loading 保持 false，避免闪「正在读取」），无缓存才显示 loading
    const hasCache = !!readLibCache<LibPage>(cacheKey);
    if (!hasCache) {
      setData(null);
      setLoading(true);
    }
    setLoadError("");
    fetch(`/api/attachments/library?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "素材加载失败");
        return body as LibPage;
      })
      .then((body) => {
        setData(body);
        writeLibCache(cacheKey, body);
        if (body.items.length === 0 && body.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(body.total / PAGE_SIZE)));
        // 预取后续第 2、3 页（写入缓存，翻页秒出）
        const totalPages = Math.max(1, Math.ceil((body.total ?? 0) / PAGE_SIZE));
        const busy = new Set<string>();
        for (let i = 2; i <= 3 && i <= totalPages; i += 1) {
          const nextKey = libCacheKey(cat, market, debouncedSearch, capSort, i);
          if (busy.has(nextKey)) continue;
          busy.add(nextKey);
          if (readLibCache<LibPage>(nextKey)) continue;
          const p = new URLSearchParams({ paged: "1", type: cat, market, q: debouncedSearch, sort: capSort === "desc" ? "cap_desc" : "cap_asc", page: String(i), pageSize: String(PAGE_SIZE) });
          void fetch(`/api/attachments/library?${p}`)
            .then((r) => r.json().catch(() => null))
            .then((pg) => { if (pg && Array.isArray(pg.items)) writeLibCache(nextKey, pg as LibPage); })
            .catch(() => {});
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "素材加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cat, market, debouncedSearch, capSort, page, refreshToken]);

  const load = useCallback(() => setRefreshToken((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener("fire:assets-updated", load);
    return () => window.removeEventListener("fire:assets-updated", load);
  }, [load]);

  const pageList = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    setSelectedId(null);
  }, [cat, market, debouncedSearch, page]);

  useEffect(() => {
    if (!preview) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => previewCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreview(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [preview]);

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  async function saveName(a: LibAsset) {
    const name = editName.trim();
    if (!name) return;
    setBusyId(a.id);
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, type: a.type, market: a.market, code: a.code, name, url: a.url })
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || "保存失败");
      showToast("名称已更新，素材库已同步");
      setEditing(null);
      window.dispatchEvent(new Event("fire:assets-updated"));
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setBusyId(null);
    }
  }

  async function removeAsset(a: LibAsset) {
    if (!await appConfirm(`确定删除「${a.name || a.code}」吗？素材库与附件管理将同步移除。`, { title: "删除素材", danger: true })) return;
    setBusyId(a.id);
    try {
      const res = await fetch(`/api/assets?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      showToast("已删除，素材库已同步");
      window.dispatchEvent(new Event("fire:assets-updated"));
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "删除失败", "err");
    } finally {
      setBusyId(null);
    }
  }

  /** 资源 URL：url 可能包含 encodeURIComponent 编码，展示/复制时转为可读形式。 */
  function resourceUrl(a: LibAsset): string {
    if (!a.url) return "";
    try {
      return decodeURIComponent(a.url);
    } catch {
      return a.url;
    }
  }

  /** 复制站内资源 URL（/uploads/...），不向前端暴露服务器磁盘绝对路径。 */
  async function copyPath(a: LibAsset) {
    const text = resourceUrl(a);
    if (!text) {
      showToast("该素材无资源 URL", "err");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制资源 URL");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("已复制资源 URL");
      } catch {
        showToast("复制失败，请手动选择复制", "err");
      }
    }
  }

  const catLabel = (a: LibAsset) =>
    a.type === "stock" ? `${MARKET_LABEL[a.market] || a.market} · ${a.board || "—"}` : a.type === "market" ? "市场" : a.type === "crypto" ? "加密货币" : "贵金属";

  const logicalLocation = (a: LibAsset) => {
    if (a.type === "stock") return `股票 / ${MARKET_LABEL[a.market] || a.market || "其他市场"}`;
    if (a.type === "market") return "市场图标";
    if (a.type === "crypto") return "加密货币";
    return "贵金属";
  };

  const selectedAsset = useMemo(() => {
    if (!selectedId || !data) return null;
    return data.items.find((asset) => asset.id === selectedId) ?? null;
  }, [data, selectedId]);
  const availableMarkets = useMemo(
    () => [...MARKET_ORDER, ...(data?.markets ?? []).filter((item) => !MARKET_ORDER.includes(item))],
    [data?.markets]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-3 p-3">
          <div data-glass-group className="flex flex-wrap items-center gap-1.5">
            {CATS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCat(c.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                  cat === c.key ? "seg-active" : "text-muted hover:bg-brand-hover hover:text-ink"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索代码 / 名称"
              className="h-[34px] w-44 rounded-full border border-edge-strong bg-white px-3.5 text-xs outline-none transition-shadow focus:border-edge-strong dark:bg-[#151a26] dark:text-[#e5e7eb]"
            />
            <button type="button" onClick={load} disabled={loading} className="btn btn-line btn-sm" title="刷新（本地变化自动同步）">
              {loading ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>
        {cat === "stock" && (
          <div data-glass-group className="flex flex-wrap items-center gap-1.5 border-t border-edge bg-[#f8f9fb] px-3 py-2.5 dark:bg-white/[0.025]">
            <span className="mr-1 text-[11px] font-semibold text-faint">股票市场</span>
            <button
              type="button"
              onClick={() => setMarket("ALL")}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${market === "ALL" ? "seg-active" : "text-muted hover:bg-brand-hover hover:text-ink"}`}
            >
              全部
            </button>
            {availableMarkets.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMarket(m)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${market === m ? "seg-active" : "text-muted hover:bg-brand-hover hover:text-ink"}`}
              >
                {MARKET_LABEL[m] || m}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="text-[11px] text-faint">
        素材库共 {data?.totalAll ?? "—"} 个 · 当前筛选 {data?.total ?? "—"} 个 · 每页 10 个
      </div>

      <div className={`library-assets-layout ${selectedAsset ? "has-details" : ""}`}>
      <div className="library-assets-table min-w-0 overflow-hidden rounded-[14px] border border-edge bg-white shadow-card dark:bg-[#16181d]" aria-busy={loading}>
        <div className="grid grid-cols-[minmax(0,1fr)_92px_110px_96px] items-center gap-3 border-b border-edge bg-[#f6f7f9] px-4 py-2 text-[11px] font-semibold text-muted dark:bg-white/5">
          <span>图标 / 名称</span>
          <button
            type="button"
            onClick={() => setCapSort((s) => (s === "desc" ? "asc" : "desc"))}
            className="inline-flex items-center justify-end gap-1 text-right transition-colors hover:text-ink"
            title="按市值排序"
          >
            市值
            <svg viewBox="0 0 24 24" fill="currentColor" className={`h-2.5 w-2.5 transition-transform ${capSort === "asc" ? "rotate-180" : ""}`}>
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <span className="text-right">市场</span>
          <span className="text-right">操作</span>
        </div>
        {loading && !data ? (
          <div className="library-assets-status"><span /><span /><span /><small>正在读取素材库</small></div>
        ) : loadError ? (
          <div className="library-assets-error"><strong>素材加载失败</strong><span>{loadError}</span><button type="button" onClick={load}>重新加载</button></div>
        ) : pageList.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">没有符合条件的素材</p>
        ) : (
          pageList.map((a) => (
            <div
              key={a.id}
              className={`library-asset-row grid cursor-pointer grid-cols-[minmax(0,1fr)_92px_110px_96px] items-center gap-3 border-b border-edge px-4 py-2 text-sm last:border-0 hover:bg-brand-hover/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand dark:border-[#2a2f3a] dark:hover:bg-white/5 ${selectedId === a.id ? "bg-brand-hover/60 dark:bg-white/[0.07]" : ""}`}
              onClick={() => setSelectedId(a.id)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedId(a.id);
                }
              }}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {a.url ? (
                  <button type="button" onClick={(event) => { event.stopPropagation(); setPreview(a); }} className="flex-none" title="点击预览">
                    <img src={a.url} alt="" className="h-9 w-9 rounded-full border border-edge bg-white object-cover" />
                  </button>
                ) : (
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-brand-light text-xs font-bold text-brand-deep">
                    {(a.name || a.code || "?").slice(0, 1)}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col items-start text-left">
                  {editing === a.id ? (
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveName(a);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      autoFocus
                      className="h-7 w-40 rounded-md border border-edge-strong px-2 text-xs outline-none"
                    />
                  ) : (
                    <>
                      <span className="block w-full truncate text-left font-semibold text-ink">{a.name || "未命名"}</span>
                      <span className="flex w-full min-w-0 items-baseline gap-1 text-left text-[11px] leading-[14px] text-faint">
                        <span className="flex-none">{a.code} ·</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] leading-[14px]" title={logicalLocation(a)}>{logicalLocation(a)}</span>
                      </span>
                    </>
                  )}
                </span>
              </span>
              <span className="text-right tabular-nums text-faint">{fmtUsd(usdCap(a.market, a.marketCap, rates)) || "—"}</span>
              <span className="flex min-w-0 items-center justify-end gap-1.5 text-xs text-muted">
                {a.type === "stock" && <MarketIcon market={a.market} size={14} />}
                <span className="truncate">{catLabel(a)}</span>
              </span>
              <span className="flex items-center justify-end gap-1.5">
                {editing === a.id ? (
                  <button type="button" disabled={busyId === a.id} onClick={() => saveName(a)} className="inline-flex h-7 flex-none items-center justify-center rounded-[8px] border border-edge px-2 text-[11px] font-semibold text-brand-deep transition-all duration-200 hover:bg-brand-hover hover:text-ink active:scale-[.97]">
                    {busyId === a.id ? "保存中…" : "保存"}
                  </button>
                ) : (
                  <button
                    type="button"
                    title="修改名称（同步素材库）"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditing(a.id);
                      setEditName(a.name);
                    }}
                    className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-edge-strong hover:bg-brand-hover hover:text-ink active:scale-[.97]"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                )}
                <button type="button" title="预览" onClick={(event) => { event.stopPropagation(); setPreview(a); }} className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-edge-strong hover:bg-brand-hover hover:text-ink active:scale-[.97]">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  title="删除（同步素材库）"
                  disabled={busyId === a.id}
                  onClick={(event) => { event.stopPropagation(); removeAsset(a); }}
                  className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-all duration-200 hover:border-down/40 hover:bg-down/10 hover:text-down active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-down/20"
                >
                  <DeleteIcon size={14} />
                </button>
              </span>
            </div>
          ))
        )}
        {loading && data && <div className="library-assets-refreshing" aria-live="polite">正在同步最新数据…</div>}
      </div>

      <div className="library-assets-mobile" aria-busy={loading}>
        {loadError ? (
          <div className="library-assets-error"><strong>素材加载失败</strong><span>{loadError}</span><button type="button" onClick={load}>重新加载</button></div>
        ) : loading && !data ? (
          <div className="library-assets-status"><span /><span /><span /><small>正在读取素材库</small></div>
        ) : pageList.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">没有符合条件的素材</p>
        ) : pageList.map((a) => (
          <article key={a.id} className={`library-asset-card ${selectedId === a.id ? "is-selected" : ""}`} onClick={() => setSelectedId(a.id)}>
            <button type="button" className="library-asset-card-icon" onClick={(event) => { event.stopPropagation(); setPreview(a); }} aria-label={`预览${a.name || a.code}`}>
              {a.url ? <img src={a.url} alt="" /> : <span>{(a.name || a.code || "?").slice(0, 1)}</span>}
            </button>
            <div className="library-asset-card-title">
              {editing === a.id ? (
                <input value={editName} onChange={(event) => setEditName(event.target.value)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") saveName(a); if (event.key === "Escape") setEditing(null); }} autoFocus />
              ) : <strong title={a.name}>{a.name || "未命名"}</strong>}
              <span><b>{a.code}</b> · {logicalLocation(a)}</span>
            </div>
            <div className="library-asset-card-meta">
              <span>{a.type === "stock" && <MarketIcon market={a.market} size={14} />}{catLabel(a)}</span>
              <strong>{fmtUsd(usdCap(a.market, a.marketCap, rates)) || "—"}</strong>
            </div>
            <div className="library-asset-card-actions">
              {editing === a.id ? (
                <button type="button" disabled={busyId === a.id} onClick={(event) => { event.stopPropagation(); saveName(a); }}>{busyId === a.id ? "保存中" : "保存"}</button>
              ) : (
                <button type="button" onClick={(event) => { event.stopPropagation(); setEditing(a.id); setEditName(a.name); }}>重命名</button>
              )}
              <button type="button" onClick={(event) => { event.stopPropagation(); setPreview(a); }}>预览</button>
              <button type="button" className="is-danger" disabled={busyId === a.id} onClick={(event) => { event.stopPropagation(); removeAsset(a); }}>删除</button>
            </div>
          </article>
        ))}
      </div>

      {selectedAsset && (
        <>
        <button type="button" className="library-asset-details-backdrop" onClick={() => setSelectedId(null)} aria-label="关闭素材详情" />
        <aside className="library-asset-details" aria-label="素材详细信息" role="dialog" aria-modal="true">
          <div className="library-asset-details-head">
            <strong>详细信息</strong>
            <button type="button" onClick={() => setSelectedId(null)} aria-label="关闭详情" title="关闭详情">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </div>
          <div className="library-asset-details-preview">
            {selectedAsset.url ? <img src={selectedAsset.url} alt="" /> : <span>{(selectedAsset.name || selectedAsset.code || "?").slice(0, 1)}</span>}
          </div>
          <h3 title={selectedAsset.name}>{selectedAsset.name || "未命名"}</h3>
          <p>{selectedAsset.code || "—"}</p>
          <dl>
            <div><dt>逻辑位置</dt><dd title={logicalLocation(selectedAsset)}>{logicalLocation(selectedAsset)}</dd></div>
            <div><dt>市场</dt><dd>{catLabel(selectedAsset)}</dd></div>
            <div className="library-asset-storage-row">
              <dt>资源 URL</dt>
              <dd>
                <span title={resourceUrl(selectedAsset) || "该素材无资源 URL"}>{resourceUrl(selectedAsset) || "—"}</span>
                {resourceUrl(selectedAsset) && (
                  <button type="button" onClick={() => copyPath(selectedAsset)} title="复制完整资源 URL" aria-label="复制完整资源 URL">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  </button>
                )}
              </dd>
            </div>
          </dl>
          <div className="library-asset-details-actions">
            <button type="button" onClick={() => setPreview(selectedAsset)}>预览素材</button>
            {selectedAsset.url && <a href={selectedAsset.url} target="_blank" rel="noreferrer">打开原文件</a>}
          </div>
        </aside>
        </>
      )}
      </div>

      {/* 分页：每页 10 */}
      {!loadError && totalPages > 1 && <Pagination page={Math.min(page, totalPages)} total={totalPages} onChange={setPage} />}

      {/* 图片预览 lightbox */}
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setPreview(null)} role="dialog" aria-modal="true" aria-label="素材预览">
          <div className="absolute inset-0 bg-black/70" />
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            {preview.url ? (
              <img src={preview.url} alt={preview.name} className="max-h-[80vh] max-w-[80vw] rounded-lg bg-white object-contain shadow-pop" />
            ) : (
              <div className="flex h-40 w-40 items-center justify-center rounded-lg bg-white text-sm text-faint">无图片</div>
            )}
            <div className="mt-2 text-center text-sm font-semibold text-white">
              {preview.name} <span className="text-white/60">{preview.code}</span>
            </div>
            <button
              ref={previewCloseRef}
              type="button"
              onClick={() => setPreview(null)}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-ink shadow-pop"
              title="关闭"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
