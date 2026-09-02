"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import type { GroupConfig, SiteSettings, TabConfig, TickerConfig } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import SettingsHeader, { SettingsSection, SubNavIcon } from "@/components/SettingsHeader";
import { LOGO_FONT_LABELS, logoFontClass } from "@/lib/logoFont";
import MarketIcon from "@/components/MarketIcon";
import DeleteIcon from "@/components/DeleteIcon";
import { CURRENT_VERSION } from "@/lib/versions";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { NAV_ICONS } from "@/lib/navIcons";
import SafeAssetImage from "@/components/SafeAssetImage";
import type { BackupConfig } from "@/lib/backup";
import { DEFAULT_HOLDING_COLUMNS } from "@/lib/holdingColumns";
import { useCurrencyDisplayUnit, type CurrencyDisplayUnit } from "@/lib/currencyPrefs";

// 版本历史弹窗按需懒加载：完整 VERSIONS 数组只在点开「版本」弹窗时下载，不进首屏包。
const VersionModal = dynamic(() => import("@/components/VersionModal"), { ssr: false });

const DEFAULT_TICKER: TickerConfig = {
  items: [
    { key: "usDJI", secid: "100.DJIA", label: "道琼斯", market: "US" },
    { key: "usIXIC", secid: "100.NDX", label: "纳斯达克综合指数", market: "US" },
    { key: "usINX", secid: "100.SPX", label: "标普500", market: "US" },
    { key: "hkHSI", secid: "100.HSI", label: "恒生指数", market: "HK" },
    { key: "sgSTI", secid: "100.STI", label: "新加坡STI", market: "SG" },
    { key: "jpN225", secid: "100.N225", label: "日经225", market: "JP" },
    { key: "krKS11", secid: "100.KS11", label: "韩国KOSPI", market: "KR" }
  ],
  interval: 5
};

interface Props {
  user: { username: string; nickname?: string; uid?: string; email?: string; avatar?: string; role?: string };
  recordsCount: number;
  onExport: () => void;
  onClearAll: (password: string) => Promise<boolean>;
  onTabsChange: (tabs: TabConfig[]) => void;
  initialSub?: string;
}

type SubKey = "site" | "stocks" | "api" | "profile" | "database" | "cron" | "about";

// 仅管理员可见的设置子项
const ADMIN_SUB_KEYS = new Set<SubKey>(["site", "stocks", "database", "cron"]);

/** ⌘K 命令搜索索引：关键词 → 子分类 + 锚点 */
const SETTINGS_SEARCH_INDEX: { sub: SubKey; anchor: string; label: string; groupLabel: string; keywords: string }[] = [
  { sub: "site", anchor: "info", label: "站点信息", groupLabel: "网站", keywords: "网站 标题 域名 注册 页脚 简介" },
  { sub: "site", anchor: "appearance", label: "网站形象", groupLabel: "网站", keywords: "图标 logo 字体 背景 形象 favicon 图片" },
  { sub: "site", anchor: "ticker", label: "首页指数", groupLabel: "网站", keywords: "指数 轮换 首页 ticker 行情条" },
  { sub: "site", anchor: "nav", label: "首页导航", groupLabel: "网站", keywords: "导航 菜单 首页 入口" },
  { sub: "stocks", anchor: "groups", label: "券商分组", groupLabel: "股票", keywords: "券商 分组 别名 持仓" },
  { sub: "stocks", anchor: "sources", label: "股票来源接口", groupLabel: "股票", keywords: "股票来源 接口 行情 财报 图标 url 数据源" },
  { sub: "stocks", anchor: "translation", label: "翻译", groupLabel: "股票", keywords: "翻译 DeepSeek 交易广场 中文" },
  { sub: "stocks", anchor: "trade", label: "交易 · 富途", groupLabel: "股票", keywords: "富途 futu opend 交易 行情源 主机 端口 腾讯 yahoo 备用" },
  { sub: "stocks", anchor: "currency-display", label: "货币金额显示", groupLabel: "股票", keywords: "货币 单位 金额 万 百万 千万 亿 缩写" },
  { sub: "profile", anchor: "profile", label: "个人信息", groupLabel: "账号", keywords: "头像 昵称 密码 邮箱 导出 清空 数据" },
  { sub: "database", anchor: "database", label: "数据库", groupLabel: "系统", keywords: "数据库 sqlite postgres 连接 存储" },
  { sub: "cron", anchor: "cron", label: "定时任务", groupLabel: "系统", keywords: "定时 汇率 缓存 自动更新 财报" },
  { sub: "api", anchor: "api", label: "API 接口", groupLabel: "系统", keywords: "api 接口 开发 文档 鉴权" },
  { sub: "about", anchor: "about", label: "关于", groupLabel: "系统", keywords: "关于 版本 技术栈 数据源 更新" }
];

const SETTINGS_ANCHOR_ICONS: Record<string, string> = {
  info: "site",
  appearance: "image",
  ticker: "stocks",
  nav: "home",
  groups: "tag",
  sources: "plug",
  trade: "trade",
  "currency-display": "stocks",
  profile: "profile",
  database: "database",
  cron: "cron",
  api: "api",
  about: "about"
};

/** 统一媒体/链接字段：标签在上，控制条在下一行（预览 + 上传 + 链接输入 + 清除/打开直链） */
function SwMediaField({
  label,
  desc,
  value,
  onChange,
  placeholder,
  inputRef,
  accept,
  onUpload,
  onClear,
  kind,
  editable = true
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  accept: string;
  onUpload: (f: File) => void;
  onClear: () => void;
  kind: "icon" | "logo" | "bg";
  editable?: boolean;
}) {
  const isUrl = /^(https?:\/\/|\/)/.test(value.trim());
  return (
    <div className="sw-media-field">
      <div className="sw-media-label">
        <b>{label}</b>
        {desc && <span>{desc}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* 预览图 + 相机浮层（悬停显示在图片内）：点击上传 */}
        <button type="button" onClick={() => inputRef.current?.click()} disabled={!editable} className="sw-media-shot group disabled:cursor-default" title="点击上传">
          {kind === "icon" && (
            <span className="h-11 w-11 overflow-hidden rounded-xl border bg-white dark:bg-[#151a26]">
              {value ? <img src={value} alt="" className="h-full w-full object-contain" /> : <span className="block h-full w-full bg-bg-gray" />}
            </span>
          )}
          {kind === "logo" && (
            <span className="h-11 w-11 overflow-hidden rounded-xl border bg-white p-1 dark:bg-[#151a26]">
              {value ? <img src={value} alt="" className="h-full w-full object-contain" /> : <span className="flex h-full w-full items-center justify-center text-[10px] text-faint">Logo</span>}
            </span>
          )}
          {kind === "bg" && (
            <span className="h-11 w-20 overflow-hidden rounded-xl border" style={value ? { backgroundImage: `url(${value})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}>
              {!value && <span className="flex h-full w-full items-center justify-center text-[10px] text-faint">背景</span>}
            </span>
          )}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/35 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" /><circle cx="12" cy="13" r="3.2" /></svg>
          </span>
        </button>
        <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
        <input value={value} readOnly={!editable} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`sw-media-input ${editable ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} />
        {value && (
          <>
            <button type="button" onClick={onClear} disabled={!editable} className="btn btn-line btn-sm disabled:opacity-50" title="清除">清除</button>
            {isUrl && (
              <a href={value} target="_blank" rel="noreferrer" className="settings-source-link" title="打开直链" aria-label={`在新窗口打开${label}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 5h5v5" /><path d="m19 5-9 9" /><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ReactBits 风格子导航胶囊：鼠标磁吸跟随 + 点击水波纹 */
function SubPill({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  function handleMove(e: ReactMouseEvent<HTMLButtonElement>) {
    const el = ref.current;
    if (!el) return;
    if (!el.classList.contains("tracking")) el.classList.add("tracking");
    const rect = el.getBoundingClientRect();
    const dx = (e.clientX - (rect.left + rect.width / 2)) / rect.width;
    const dy = (e.clientY - (rect.top + rect.height / 2)) / rect.height;
    el.style.transform = `translate(${(dx * 4).toFixed(2)}px, ${(dy * 3).toFixed(2)}px)`;
  }

  function handleLeave() {
    setHovered(false);
    const el = ref.current;
    if (el) {
      el.classList.remove("tracking");
      el.style.transform = "translate(0px, 0px)";
    }
  }

  function handleClick(e: ReactMouseEvent<HTMLButtonElement>) {
    const el = ref.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const id = Date.now() + Math.random();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setRipples((rs) => [...rs, { id, x, y }]);
      window.setTimeout(() => setRipples((rs) => rs.filter((r) => r.id !== id)), 650);
    }
    onClick();
  }

  return (
    <button
      ref={ref}
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className={`pill-magnetic relative flex items-center gap-1.5 overflow-hidden rounded-full px-4 py-2 text-[13px] font-semibold ${
        active
          ? "bg-white text-ink-2 border border-edge-strong shadow-sm shadow-sm active:bg-bg-gray"
          : "text-muted hover:bg-brand-hover active:bg-bg-gray"
      }`}
    >
      {icon}
      {label}
      {ripples.map((r) => (
        <span
          key={r.id}
          className="pill-ripple"
          style={{
            left: r.x,
            top: r.y,
            background: hovered || active ? "rgba(255,255,255,.45)" : "rgba(107,114,128,.22)"
          }}
        />
      ))}
    </button>
  );
}

const SUB_NAV: { key: SubKey; label: string }[] = [
  { key: "site", label: "网站设置" },
  { key: "stocks", label: "股票设置" },
  { key: "profile", label: "个人信息" },
  { key: "database", label: "数据库增强" },
  { key: "cron", label: "定时任务" },
  { key: "api", label: "API 开发接口" },
  { key: "about", label: "关于" }
];

const SUB_GROUPS: { label: string; items: { key: SubKey; label: string; desc: string }[] }[] = [
  {
    label: "站点",
    items: [
      { key: "site", label: "网站设置", desc: "站点信息与首页文案、导航" }
    ]
  },
  {
    label: "股票",
    items: [{ key: "stocks", label: "股票设置", desc: "券商管理与数据来源接口" }]
  },
  {
    label: "账号",
    items: [{ key: "profile", label: "个人信息", desc: "头像、资料、密码、数据管理" }]
  },
  {
    label: "系统",
    items: [
      { key: "database", label: "数据库增强", desc: "SQLite / PostgreSQL 配置" },
      { key: "cron", label: "定时任务", desc: "汇率刷新、数据缓存与自动更新" },
      { key: "api", label: "API 开发接口", desc: "后端接口一览与鉴权说明" },
      { key: "about", label: "关于", desc: "网站技术栈、数据源与版本信息" }
    ]
  }
];

const DEFAULT_TABS: TabConfig[] = [
  { key: "watchlist", label: "自选股", url: "/watchlist" },
  { key: "holdings", label: "账户资产", url: "/holdings", default: true },
  { key: "global", label: "全球预览", url: "/global" },
  { key: "earnings", label: "财报日历", url: "/earnings" },
  { key: "celebs", label: "名人持仓", url: "/celebs" },
  { key: "users", label: "用户管理", url: "/users" },
  { key: "attachments", label: "附件管理", url: "/attachments" },
  { key: "library", label: "素材库", url: "/library" },
  { key: "activities", label: "日志", url: "/activities" },
  { key: "settings", label: "设置", url: "/settings" }
];

function CronRefreshButton() {
  const [busy, setBusy] = useState(false);
  async function refreshRates() {
    setBusy(true);
    try {
      const res = await fetch("/api/rates?refresh=1");
      const data = await res.json().catch(() => null);
      if (res.ok && data?.rates) {
        showToast("汇率已立即刷新");
        window.dispatchEvent(new Event("fire:rates-updated"));
      } else {
        showToast(data?.error || "刷新失败", "err");
      }
    } catch {
      showToast("刷新失败", "err");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" onClick={refreshRates} disabled={busy} className="btn btn-ghost btn-sm disabled:opacity-60">
      {busy ? "刷新中…" : "立即刷新"}
    </button>
  );
}

/* 数据库定时备份卡片：配置开关 / 间隔 / 保留份数 + 立即备份 */
function BackupTaskCard() {
  const [cfg, setCfg] = useState<BackupConfig | null>(null);
  const [backups, setBackups] = useState<{ name: string; size: number; mtime: number }[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [intervalHours, setIntervalHours] = useState(24);
  const [keep, setKeep] = useState(7);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/backup");
      const data = await res.json().catch(() => null);
      if (data?.config) {
        setCfg(data.config);
        setEnabled(data.config.enabled);
        setIntervalHours(data.config.intervalHours);
        setKeep(data.config.keep);
      }
      if (Array.isArray(data?.backups)) setBackups(data.backups);
    } catch {
      /* 忽略 */
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/backup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, intervalHours, keep })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      showToast("备份设置已保存");
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "保存失败", "err");
    } finally {
      setSaving(false);
    }
  }

  async function backupNow() {
    setBusy(true);
    try {
      const res = await fetch("/api/backup", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "备份失败");
      showToast(`备份完成：${data.name}`);
      await refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "备份失败", "err");
    } finally {
      setBusy(false);
    }
  }

  const last = cfg?.lastAt
    ? new Date(cfg.lastAt).toLocaleString("zh-CN", { hour12: false })
    : "从未备份";
  const totalSize = backups.reduce((s, b) => s + b.size, 0);
  const fmtSize = (n: number) =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
  const intervalLabel = intervalHours === 1 ? "每小时" : intervalHours === 24 ? "每天" : intervalHours === 168 ? "每周" : intervalHours === 720 ? "每月" : `${intervalHours} 小时`;

  return (
    <div className="settings-task-row settings-backup-row">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-edge text-muted">
          <SubNavIcon name="database" className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink">数据库定时备份</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                enabled ? "bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white" : "bg-bg-gray text-muted"
              }`}
            >
              {enabled ? "已启用" : "已停用"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            SQLite 在线快照（WAL 安全）+ 素材库，自动保存到 data/backups 并保留最近 {keep} 份
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-ink-2">
            <label className="flex cursor-pointer items-center gap-1.5">
              <span className="text-faint">开关</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((v) => !v)}
                className={`relative h-[22px] w-[40px] rounded-full transition-colors duration-200 ${enabled ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}
              >
                <span
                  className={`absolute top-[2px] h-[18px] w-[18px] rounded-full shadow transition-all duration-200 ${
                    enabled ? "left-[20px]" : "left-[2px]"
                  }`}
                  style={{ backgroundColor: "#ffffff" }}
                />
              </button>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-faint">间隔</span>
              <select
                value={intervalHours}
                onChange={(e) => setIntervalHours(Number(e.target.value))}
                className="rounded-lg border border-edge bg-white px-2 py-1 text-[12px] font-medium text-ink outline-none focus:border-edge-strong dark:bg-white/5"
              >
                <option value={1}>每小时</option>
                <option value={24}>每天</option>
                <option value={168}>每周</option>
                <option value={720}>每月</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-faint">保留</span>
              <select
                value={keep}
                onChange={(e) => setKeep(Number(e.target.value))}
                className="rounded-lg border border-edge bg-white px-2 py-1 text-[12px] font-medium text-ink outline-none focus:border-edge-strong dark:bg-white/5"
              >
                <option value={3}>3 份</option>
                <option value={7}>7 份</option>
                <option value={14}>14 份</option>
                <option value={30}>30 份</option>
              </select>
            </label>
            <span className="text-faint">
              上次 {last} · 共 {backups.length} 份 · {fmtSize(totalSize)}
            </span>
          </div>
        </div>
        <div className="flex flex-none flex-col items-end gap-2">
          <button type="button" onClick={backupNow} disabled={busy} className="btn btn-line btn-sm disabled:opacity-60">
            {busy ? "备份中…" : "立即备份"}
          </button>
          <span className="text-[11px] text-faint">当前计划：{intervalLabel}</span>
          <button type="button" onClick={save} disabled={saving} className="btn btn-soft btn-sm disabled:opacity-60">
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}

const TAB_HINTS: Record<string, string> = {
  holdings: "账户资产",
  watchlist: "自选股",
  global: "全球预览",
  earnings: "财报日历",
  users: "用户管理",
  library: "素材库",
  activities: "日志",
  settings: "设置"
};

const DEFAULT_SETTINGS: SiteSettings = {
  domain: "",
  title: "",
  ico: "",
  homepageBg: "",
  loginSideImage: "",
  tabs: DEFAULT_TABS,
  groups: [],
  homeNav: [],
  markets: [],
  marketLabels: [],
  assetMarketOrder: [],
  indicesOrder: [],
  allowRegister: true,
  stockIconCdn: false,
  siteLogo: "",
  logoText: "",
  logoFont: "diatype",
  quoteSource: "auto",
  futuHost: "127.0.0.1",
  futuPort: "11111",
  footerDesc: "",
  quoteApiUrl: "",
  searchApiUrl: "",
  chartApiUrl: "",
  currencyApiUrl: "",
  earningsApiUrl: "",
  cnEarningsApiUrl: "",
  usLogoApiUrl: "",
  cnLogoApiUrl: "",
  trumpArchiveApiUrl: "",
  translationApiUrl: "",
  translationProvider: "mymemory",
  deepseekApiUrl: "",
  deepseekModel: "deepseek-chat",
  deepseekApiKey: "",
  translationEnabled: true,
  dbType: "sqlite",
  pgHost: "",
  pgPort: "5432",
  pgDatabase: "",
  pgUser: "",
  pgPassword: "",
  holdingColumns: DEFAULT_HOLDING_COLUMNS,
  ticker: DEFAULT_TICKER
};

interface DbStatus {
  type: string;
  file: string;
  sizeBytes: number;
  tables: string[];
  configuredType: string;
}

// 股票来源接口的卡片元数据（顺序即展示顺序）
const SOURCE_FIELDS: {
  key: "quoteApiUrl" | "searchApiUrl" | "chartApiUrl" | "currencyApiUrl" | "earningsApiUrl" | "cnEarningsApiUrl" | "usLogoApiUrl" | "cnLogoApiUrl" | "trumpArchiveApiUrl" | "translationApiUrl" | "deepseekApiUrl" | "deepseekModel" | "deepseekApiKey" | "translationProvider";
  name: string;
  desc: string;
  placeholder: string;
  icon: "chart" | "search" | "wave" | "money" | "cal" | "cn" | "us" | "logo" | "trump" | "translate";
}[] = [
  { key: "quoteApiUrl", name: "实时行情", desc: "直接拼接股票代码，多个用逗号分隔", placeholder: "https://qt.gtimg.cn/q=", icon: "chart" },
  { key: "searchApiUrl", name: "搜索联想", desc: "用 {q} 代替查询词", placeholder: "https://smartbox.gtimg.cn/s3/?v=2&q={q}&t=all", icon: "search" },
  { key: "chartApiUrl", name: "分时走势", desc: "用 {code} 代替股票代码", placeholder: "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}", icon: "wave" },
  { key: "currencyApiUrl", name: "汇率接口", desc: "每日 9:00 / 23:00 各刷新一次", placeholder: "https://api.frankfurter.dev/v1/latest", icon: "money" },
  { key: "earningsApiUrl", name: "美股财报", desc: "直接拼接日期 YYYY-MM-DD", placeholder: "https://api.nasdaq.com/api/calendar/earnings?date=", icon: "cal" },
  { key: "cnEarningsApiUrl", name: "A股财报", desc: "东方财富预约披露，自动拼接报表参数", placeholder: "https://datacenter.eastmoney.com/securities/api/data/v1/get", icon: "cn" },
  { key: "usLogoApiUrl", name: "美股公司图标", desc: "直接拼接代码 .png", placeholder: "https://g.foolcdn.com/art/companylogos/square/", icon: "us" },
  { key: "cnLogoApiUrl", name: "A股公司图标", desc: "自动拼接 代码.SS / 代码.SZ", placeholder: "https://assets.parqet.com/logos/symbol/", icon: "logo" },
  { key: "trumpArchiveApiUrl", name: "特朗普平台归档", desc: "交易广场公开动态来源", placeholder: "https://trumpstruth.org/", icon: "trump" },
  { key: "translationProvider", name: "翻译提供商", desc: "mymemory / deepseek / openai-compatible", placeholder: "deepseek", icon: "translate" },
  { key: "translationApiUrl", name: "动态翻译接口", desc: "免费或自建翻译接口", placeholder: "https://api.mymemory.translated.net/get", icon: "translate" },
  { key: "deepseekApiUrl", name: "DeepSeek API 地址", desc: "OpenAI 兼容 Chat Completions 地址", placeholder: "https://api.deepseek.com/chat/completions", icon: "translate" },
  { key: "deepseekModel", name: "DeepSeek 模型", desc: "默认使用 deepseek-chat", placeholder: "deepseek-chat", icon: "translate" },
  { key: "deepseekApiKey", name: "DeepSeek API Key", desc: "仅服务端使用，不下发浏览器", placeholder: "sk-…", icon: "translate" }
];

const SOURCE_ICON_PATHS: Record<string, React.ReactNode> = {
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15.5 10 12l3 2.5 4.5-6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  wave: (
    <>
      <path d="M2 12c1.5 0 1.5-2 3-2s1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2 1.5 2 3 2" />
      <path d="M2 17c1.5 0 1.5-2 3-2s1.5 2 3 2 1.5-2 3-2 1.5 2 3 2 1.5-2 3-2 1.5 2 3 2" />
    </>
  ),
  money: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
      <path d="M9 9h6" />
      <path d="M9 15h6" />
    </>
  ),
  cal: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2.5" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M3 9h18" />
    </>
  ),
  cn: (
    <>
      <path d="M3 3v18h18" />
      <path d="m8 15 3-3 2 2 4-5" />
    </>
  ),
  us: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
    </>
  ),
  logo: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 8h8v8H8z" />
    </>
  )
};

// —— 品牌花标“点击一次转一圈、连续点击连续转”的临界阻尼弹簧参数 ——
// 每次点击让目标角度 +360°：单次点击会平滑转满一整圈后停稳；
// 连续点击则目标不断前移，弹簧持续追赶，产生连续顺滑的转动。
// 临界阻尼（无过冲、无回弹）+ 弹簧自身正是“起步缓、中间快、收尾柔”的缘故，
// 比直接给速度/摩擦更流畅，不会有速度突跳或生硬停下的卡顿感。
const BRAND_STIFFNESS = 58; // 弹簧刚度（越大转越快）
const BRAND_DAMPING = 2 * Math.sqrt(BRAND_STIFFNESS); // 临界阻尼
const BRAND_TURN = 360; // 每次点击的目标增量（一整圈）
const BRAND_MAX_VEL = 2000; // 角速度上限（deg/s），连续狂点时避免过快导致视觉拖影/频闪

export default function SettingsView({ user, recordsCount, onExport, onClearAll, onTabsChange, initialSub }: Props) {
  const isAdminUser = user?.role === "admin";
  const { unit: currencyDisplayUnit, setUnit: setCurrencyDisplayUnit } = useCurrencyDisplayUnit();
  const [brandSpinning, setBrandSpinning] = useState(false);
  // 品牌花标转动系统：临界阻尼弹簧在“角度目标”上做物理积分，
  // 目标每点击 +360°，弹簧平滑地追赶并最终停在整数圈，观感流畅。
  const petalsRef = useRef<SVGGElement | null>(null);
  const brandInnerRef = useRef<SVGGElement | null>(null);
  const brandPos = useRef(0); // 当前角度（deg）
  const brandVel = useRef(0); // 当前角速度（deg/s）
  const brandTarget = useRef(0); // 目标角度（deg），每次点击 +360
  const brandLastTs = useRef(0);
  const brandRaf = useRef<number | null>(null);
  const brandMoving = useRef(false);
  const brandReduced = useRef(false);

  function kickBrand() {
    if (brandReduced.current) return;
    // 每次点击目标再加一整圈；弹簧会平滑地追上去，连续点击即连续转。
    brandTarget.current += BRAND_TURN;
    if (brandRaf.current == null) {
      brandLastTs.current = performance.now();
      brandRaf.current = requestAnimationFrame(brandStep);
    }
  }

  function brandStep(ts: number) {
    const dt = Math.min(0.05, (ts - brandLastTs.current) / 1000);
    brandLastTs.current = ts;
    const err = brandTarget.current - brandPos.current;
    const accel = BRAND_STIFFNESS * err - BRAND_DAMPING * brandVel.current;
    brandVel.current += accel * dt;
    if (brandVel.current > BRAND_MAX_VEL) brandVel.current = BRAND_MAX_VEL;
    else if (brandVel.current < -BRAND_MAX_VEL) brandVel.current = -BRAND_MAX_VEL;
    brandPos.current += brandVel.current * dt;
    if (petalsRef.current) petalsRef.current.style.transform = `rotate(${brandPos.current}deg)`;
    if (brandInnerRef.current) brandInnerRef.current.style.transform = `rotate(${-brandPos.current}deg)`;
    const moving = Math.abs(brandVel.current) > 4 || Math.abs(err) > 2;
    if (moving !== brandMoving.current) {
      brandMoving.current = moving;
      setBrandSpinning(moving);
    }
    if (Math.abs(err) > 1 || Math.abs(brandVel.current) > 4) {
      brandRaf.current = requestAnimationFrame(brandStep);
    } else {
      // 停稳：吸附到整数圈目标，避免弹簧无限逼近造成细微抖动
      brandPos.current = brandTarget.current;
      brandVel.current = 0;
      brandRaf.current = null;
      if (brandMoving.current) {
        brandMoving.current = false;
        setBrandSpinning(false);
      }
    }
  }

  useEffect(() => {
    brandReduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return () => {
      if (brandRaf.current != null) cancelAnimationFrame(brandRaf.current);
      brandRaf.current = null;
    };
  }, []);

  const { assets: libraryAssets, assetIcons } = useAssetIcons(["broker", "icon"]);
  const brokerIconOf = (groupId: string) =>
    libraryAssets.find((a) => a.type === "broker" && a.code.toLowerCase() === groupId.toLowerCase())?.url ?? "";
  const navIconRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // 上传导航图标：写入素材库 icon:<KEY>，侧栏 / 移动端标签 / 素材库 icon 类目全局生效
  async function uploadNavIcon(file: File, key: string, label: string) {
    const busyKey = `nav-icon:${key}`;
    setBlockSaving((b) => ({ ...b, [busyKey]: true }));
    try {
      const fd = new FormData();
      fd.append("kind", "asset");
      fd.append("folder", "icon");
      fd.append("code", key.toUpperCase());
      fd.append("name", label);
      fd.append("file", file);
      const up = await fetch("/api/upload", { method: "POST", body: fd });
      const upData = await up.json().catch(() => null);
      if (!up.ok) throw new Error(upData?.error || "上传失败");
      const existing = libraryAssets.find((a) => a.type === "icon" && a.code.toUpperCase() === key.toUpperCase());
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "icon",
          market: "OTHER",
          code: key.toUpperCase(),
          name: existing?.name || label,
          url: upData.url,
          id: existing?.id || undefined
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      window.dispatchEvent(new Event("fire:assets-updated"));
      showToast(`「${label}」图标已更新，全局生效`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
    } finally {
      setBlockSaving((b) => ({ ...b, [busyKey]: false }));
    }
  }
  const visibleSubNav = SUB_NAV.filter((s) => isAdminUser || !ADMIN_SUB_KEYS.has(s.key));
  const visibleGroups = SUB_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((it) => isAdminUser || !ADMIN_SUB_KEYS.has(it.key)) }))
    .filter((g) => g.items.length > 0);
  // 细粒度侧栏导航：与 ⌘K 搜索索引一致（站点信息/网站形象/首页指数…，各占一项）
  const navGroups = SETTINGS_SEARCH_INDEX
    .filter((it) => isAdminUser || !ADMIN_SUB_KEYS.has(it.sub))
    .reduce<{ label: string; items: { sub: SubKey; anchor: string; label: string; groupLabel: string }[] }[]>((acc, it) => {
      const g = acc.find((x) => x.label === it.groupLabel);
      if (g) g.items.push({ sub: it.sub, anchor: it.anchor, label: it.label, groupLabel: it.groupLabel });
      else acc.push({ label: it.groupLabel, items: [{ sub: it.sub, anchor: it.anchor, label: it.label, groupLabel: it.groupLabel }] });
      return acc;
    }, []);
  const [sub, setSub] = useState<SubKey>(() => {
    const valid = initialSub === "site" || initialSub === "stocks" || initialSub === "api" || initialSub === "profile" || initialSub === "database" || initialSub === "cron" || initialSub === "about"
      ? (initialSub as SubKey)
      : (isAdminUser ? "site" : "profile");
    return isAdminUser || !ADMIN_SUB_KEYS.has(valid) ? valid : "profile";
  });
  const [activeAnchor, setActiveAnchor] = useState<string>(() => {
    const valid = (initialSub === "site" || initialSub === "stocks" || initialSub === "api" || initialSub === "profile" || initialSub === "database" || initialSub === "cron" || initialSub === "about") ? initialSub : (isAdminUser ? "site" : "profile");
    const requested = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("anchor") : null;
    return requested && SETTINGS_SEARCH_INDEX.some((x) => x.sub === valid && x.anchor === requested) ? requested : SETTINGS_SEARCH_INDEX.find((x) => x.sub === valid)?.anchor || "info";
  });
  const activeSubMeta = visibleGroups.flatMap((g) => g.items).find((item) => item.key === sub);
  const [site, setSite] = useState<SiteSettings>(DEFAULT_SETTINGS);
  const [tabs, setTabs] = useState<TabConfig[]>(DEFAULT_TABS);
  const [stockGroups, setStockGroups] = useState<GroupConfig[]>([]);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [dbStatusLoading, setDbStatusLoading] = useState(false);
  const [dbStatusError, setDbStatusError] = useState("");
  const [dbStatusRetry, setDbStatusRetry] = useState(0);
  const [blockSaving, setBlockSaving] = useState<Record<string, boolean>>({});
  const [blockMsg, setBlockMsg] = useState<Record<string, { type: "ok" | "err"; text: string } | undefined>>({});
  const [dbMsg, setDbMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [dbSaving, setDbSaving] = useState(false);
  const [dbTesting, setDbTesting] = useState(false);
  const icoRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const loginImgRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const nickInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [me, setMe] = useState({ username: user.username, nickname: user.nickname ?? "", uid: user.uid ?? "", email: user.email ?? "", avatar: user.avatar ?? "" });
  const [nickname, setNickname] = useState(user.nickname ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [nickMsg, setNickMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [versionOpen, setVersionOpen] = useState(false);
  const tabDragIndex = useRef<number | null>(null);
  const groupDragIndex = useRef<number | null>(null);
  const navDragIndex = useRef<number | null>(null);
  const tickerDragIndex = useRef<number | null>(null);

  useEffect(() => {
    if (initialSub === "site" || initialSub === "stocks" || initialSub === "api" || initialSub === "profile" || initialSub === "database" || initialSub === "cron" || initialSub === "about") {
      const next = initialSub as SubKey;
      setSub(isAdminUser || !ADMIN_SUB_KEYS.has(next) ? next : "profile");
    }
  }, [initialSub, isAdminUser]);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.settings) {
          setSite({ ...DEFAULT_SETTINGS, ...data.settings });
          captureSaved(data.settings);
          setTabs(data.settings.tabs ?? DEFAULT_TABS);
          setStockGroups(data.settings.groups ?? []);
          setGroupsLoaded(true);
        }
      })
      .catch(() => {
        showToast("设置加载失败，已保留当前配置，可刷新后重试", "err");
      })
      .finally(() => {
        // 网络异常也必须解除保存按钮的永久「加载中」状态。
        setGroupsLoaded(true);
      });
  }, []);

  // 对照 mockup：点导航只显示该区块、隐藏同组其他区块（仅隐藏带锚点且锚点在搜索索引里的区块，避免误伤「用户头像」等）
  useEffect(() => {
    const anchors = new Set(SETTINGS_SEARCH_INDEX.map((x) => x.anchor));
    document.querySelectorAll<HTMLElement>(".settings-section-card[id]").forEach((el) => {
      if (anchors.has(el.id)) el.hidden = el.id !== activeAnchor;
    });
  }, [sub, activeAnchor]);

  useEffect(() => {
    if (sub !== "database") return;
    let cancelled = false;
    setDbStatusLoading(true);
    setDbStatusError("");
    fetch("/api/db/status")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.status) throw new Error(data?.error || "数据库状态加载失败");
        return data.status as DbStatus;
      })
      .then((status) => {
        if (!cancelled) setDbStatus(status);
      })
      .catch((error) => {
        if (!cancelled) setDbStatusError(error instanceof Error ? error.message : "数据库状态加载失败");
      })
      .finally(() => {
        if (!cancelled) setDbStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sub, dbStatusRetry]);

  async function uploadSiteFile(kind: "ico" | "background", file: File): Promise<string> {
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      setSite((s) => ({ ...s, [kind]: data.url }));
      return data.url as string;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
      return "";
    }
  }

  async function uploadLogo(file: File): Promise<string> {
    try {
      const fd = new FormData();
      fd.append("kind", "logo");
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      setSite((s) => ({ ...s, siteLogo: data.url }));
      return data.url as string;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
      return "";
    }
  }

  async function uploadLoginImage(file: File): Promise<string> {
    try {
      const fd = new FormData();
      fd.append("kind", "login");
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      setSite((s) => ({ ...s, loginSideImage: data.url }));
      return data.url as string;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
      return "";
    }
  }

  async function saveBlock(key: string, fields: Partial<SiteSettings>, hint: string) {
    setBlockSaving((b) => ({ ...b, [key]: true }));
    setBlockMsg((m) => ({ ...m, [key]: undefined }));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setSite((s) => ({ ...s, ...data.settings }));
      captureSaved(data.settings);
      setBlockMsg((m) => ({ ...m, [key]: { type: "ok", text: hint } }));
      showToast(hint);
      window.dispatchEvent(new Event("fire:settings-updated"));
      window.dispatchEvent(new Event("fire:records-updated"));
      return true;
    } catch (err) {
      setBlockMsg((m) => ({ ...m, [key]: { type: "err", text: err instanceof Error ? err.message : "保存失败" } }));
      return false;
    } finally {
      setBlockSaving((b) => ({ ...b, [key]: false }));
    }
  }

  function setSiteField(key: keyof SiteSettings, value: string) {
    setSite((s) => ({ ...s, [key]: value }));
  }

  /* ---------- 全局自动保存：修改即保存，失败通过 Toast 提示 ---------- */
  const savedRef = useRef<Record<string, unknown> | null>(null);

  function autoSaveSnapshot(s: SiteSettings) {
    return {
      title: s.title,
      domain: s.domain,
      allowRegister: s.allowRegister,
      footerDesc: s.footerDesc,
      ico: s.ico,
      siteLogo: s.siteLogo,
      logoText: s.logoText,
      logoFont: s.logoFont,
      homepageBg: s.homepageBg,
      loginSideImage: s.loginSideImage,
      quoteApiUrl: s.quoteApiUrl,
      searchApiUrl: s.searchApiUrl,
      chartApiUrl: s.chartApiUrl,
      currencyApiUrl: s.currencyApiUrl,
      earningsApiUrl: s.earningsApiUrl,
      cnEarningsApiUrl: s.cnEarningsApiUrl,
      usLogoApiUrl: s.usLogoApiUrl,
      cnLogoApiUrl: s.cnLogoApiUrl,
      futuHost: s.futuHost,
      futuPort: s.futuPort,
      quoteSource: s.quoteSource,
      ticker: JSON.stringify(s.ticker),
      homeNav: JSON.stringify(s.homeNav)
    };
  }

  function captureSaved(s: SiteSettings) {
    savedRef.current = autoSaveSnapshot(s);
  }

  useEffect(() => {
    if (!savedRef.current) return;
    const saved = savedRef.current;
    const cur = autoSaveSnapshot(site) as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    Object.keys(cur).forEach((key) => {
      if (cur[key] !== saved[key]) patch[key] = cur[key];
    });
    if (Object.keys(patch).length === 0) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch)
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "保存失败");
        captureSaved(data.settings);
        window.dispatchEvent(new Event("fire:settings-updated"));
      } catch (err) {
        showToast(err instanceof Error ? err.message : "保存失败，请稍后重试");
      }
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  function resetBrand() {
    if (!confirm("确定将网站形象恢复默认吗？将清空网站图标、Logo 图片、网站背景图与登录页左侧图，Logo 文字恢复为 Fire。")) return;
    saveBlock("brand", { ico: "", siteLogo: "", logoText: "Fire", logoFont: "diatype", homepageBg: "", loginSideImage: "" }, "网站形象已重置");
  }

  function setTickerInterval(v: number) {
    const n = Number.isFinite(v) ? Math.min(60, Math.max(3, Math.round(v))) : DEFAULT_TICKER.interval;
    setSite((s) => ({ ...s, ticker: { ...s.ticker, interval: n } }));
  }

  function setTickerItem(index: number, patch: Partial<TickerConfig["items"][number]>) {
    setSite((s) => ({
      ...s,
      ticker: {
        ...s.ticker,
        items: s.ticker.items.map((it, i) => (i === index ? { ...it, ...patch } : it))
      }
    }));
  }

  function addTickerItem() {
    setSite((s) => ({
      ...s,
      ticker: {
        ...s.ticker,
        items: [...s.ticker.items, { key: `t${Date.now()}`, label: "新指数", secid: "100.DJIA", market: "US" }]
      }
    }));
  }

  function removeTickerItem(index: number) {
    setSite((s) => ({
      ...s,
      ticker: { ...s.ticker, items: s.ticker.items.filter((_, i) => i !== index) }
    }));
  }

  function dropTickerRow(to: number) {
    if (tickerDragIndex.current === null) return;
    const from = tickerDragIndex.current;
    tickerDragIndex.current = null;
    if (from === to) return;
    setSite((s) => {
      const items = [...s.ticker.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { ...s, ticker: { ...s.ticker, items } };
    });
  }

  function setNav(key: string, patch: Partial<{ label: string; href: string; enabled: boolean }>) {
    setSite((s) => ({
      ...s,
      homeNav: (s.homeNav || []).map((n) => (n.key === key ? { ...n, ...patch } : n))
    }));
  }

  function dropNavRow(to: number) {
    if (navDragIndex.current === null) return;
    const from = navDragIndex.current;
    navDragIndex.current = null;
    if (from === to) return;
    setSite((s) => {
      const next = [...(s.homeNav || [])];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { ...s, homeNav: next };
    });
  }

  async function uploadAvatar(file: File) {
    setAvatarUploading(true);
    setAvatarMsg(null);
    try {
      const fd = new FormData();
      fd.append("kind", "avatar");
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      const meRes = await fetch("/api/auth/me");
      const meData = await meRes.json();
      setMe({ username: meData.user.username, nickname: meData.user.nickname ?? "", uid: meData.user.uid ?? "", email: meData.user.email ?? "", avatar: meData.user.avatar });
      setNickname(meData.user.nickname ?? "");
      setEmail(meData.user.email ?? "");
      window.dispatchEvent(new Event("fire:user-updated"));
      setAvatarMsg({ type: "ok", text: "头像已更新，右上角已同步" });
      showToast("头像已更新");
    } catch (err) {
      setAvatarMsg({ type: "err", text: err instanceof Error ? err.message : "上传失败" });
    } finally {
      setAvatarUploading(false);
    }
  }

  async function saveProfile() {
    setNickMsg(null);
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, email, currentPassword: profilePassword })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setMe((m) => ({ ...m, nickname: data.user.nickname, email: data.user.email }));
      setNickname(data.user.nickname);
      setEmail(data.user.email);
      setProfilePassword("");
      window.dispatchEvent(new Event("fire:user-updated"));
      setNickMsg({ type: "ok", text: "个人资料已更新" });
      showToast("个人资料已更新");
      setEditingProfile(false);
    } catch (err) {
      setNickMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    }
  }

  async function exportSiteBackup() {
    if (!confirm("导出的 fire-backup-*.json 包含全部站点配置与用户数据（不含数据库连接串等环境专属设置），请妥善保管。继续导出？")) return;
    setBackupBusy("export");
    try {
      const res = await fetch("/api/v1/data/export");
      if (!res.ok) throw new Error("导出失败");
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fire-backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const c = payload?.manifest?.counts;
      showToast(`已导出：持仓 ${c?.records ?? 0}、订单 ${c?.tradeOrders ?? 0}、分组 ${c?.watchGroups ?? 0}、设置 ${c?.siteSettings ?? 0}、名人持仓 ${c?.celebs ?? 0}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "导出失败", "err");
    } finally {
      setBackupBusy(null);
    }
  }

  async function importSiteBackup(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      showToast("备份文件超过 10MB 限制", "err");
      return;
    }
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      showToast("文件解析失败，请选择 fire-backup-*.json", "err");
      return;
    }
    setBackupBusy("import");
    try {
      // 第一步：服务端校验 + 试算条数（不写入）
      const checkRes = await fetch("/api/v1/data/import?preview=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const checkData = await checkRes.json().catch(() => null);
      if (!checkRes.ok) throw new Error(checkData?.error || "备份文件校验失败");
      const counts = checkData?.counts ?? {};
      const summary = [
        `版本：${payload?.appVersion ?? "未知"} · 导出：${(payload?.exportedAt ?? "").replace("T", " ").slice(0, 16)}`,
        `持仓 ${counts.records ?? 0}、订单 ${counts.tradeOrders ?? 0}、分组 ${counts.watchGroups ?? 0}、设置 ${counts.siteSettings ?? 0}、名人持仓 ${counts.celebs ?? 0}${counts.profile ? "、昵称" : ""}`
      ].join("\n");
      if (!confirm(`导入网站数据？\n\n${summary}\n\n将按 id 与当前数据「存在则更新、不存在则插入」合并，不会删除现有数据；导入前自动备份当前数据库。确定继续？`)) return;
      // 第二步：真正导入
      const res = await fetch("/api/v1/data/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "导入失败");
      const c = data?.counts ?? {};
      showToast(`导入成功：持仓 ${c.records ?? 0}、订单 ${c.tradeOrders ?? 0}、分组 ${c.watchGroups ?? 0}、设置 ${c.siteSettings ?? 0}、名人持仓 ${c.celebs ?? 0}`);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "导入失败", "err");
    } finally {
      setBackupBusy(null);
      if (importBackupRef.current) importBackupRef.current.value = "";
    }
  }

  async function doDeleteAccount() {
    try {
      const res = await fetch("/api/v1/auth/delete-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: deletePassword }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "注销失败");
      showToast("账号已注销");
      setTimeout(() => { window.location.href = "/login"; }, 1000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "注销失败", "err");
    }
  }

  function moveTab(index: number, dir: -1 | 1) {
    setTabs((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function moveGroup(index: number, dir: -1 | 1) {
    setStockGroups((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function dropTabRow(to: number) {
    if (tabDragIndex.current === null) return;
    const from = tabDragIndex.current;
    tabDragIndex.current = null;
    if (from === to) return;
    setTabs((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function dropGroupRow(to: number) {
    if (groupDragIndex.current === null) return;
    const from = groupDragIndex.current;
    groupDragIndex.current = null;
    if (from === to) return;
    setStockGroups((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function addGroup() {
    setShowAllStockGroups(true);
    setEditingStockGroups(true);
    setStockGroups((prev) => [...prev, { id: `g${Date.now()}-${prev.length}`, name: "新券商", alias: "" }]);
  }

  const [groupMsg, setGroupMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [showAllStockGroups, setShowAllStockGroups] = useState(false);
  const [editingStockGroups, setEditingStockGroups] = useState(false);
  const [editingTicker, setEditingTicker] = useState(false);
  const [editingHomeNav, setEditingHomeNav] = useState(false);
  const [editingTabs, setEditingTabs] = useState(false);
  const [showAllTicker, setShowAllTicker] = useState(false);
  const [showAllHomeNav, setShowAllHomeNav] = useState(false);
  const [showAllTabs, setShowAllTabs] = useState(false);
  const [editingSources, setEditingSources] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingSiteInfo, setEditingSiteInfo] = useState(false);
  const [editingFutu, setEditingFutu] = useState(false);
  const [editingAppearance, setEditingAppearance] = useState(false);
  const [editingDb, setEditingDb] = useState(false);
  const activeEditState = activeAnchor === "info" ? editingSiteInfo
    : activeAnchor === "appearance" ? editingAppearance
      : activeAnchor === "ticker" ? editingTicker
        : activeAnchor === "nav" ? (editingHomeNav || editingTabs)
          : activeAnchor === "groups" ? editingStockGroups
            : activeAnchor === "sources" || activeAnchor === "translation" ? editingSources
              : activeAnchor === "trade" ? editingFutu
                : activeAnchor === "profile" ? editingProfile
                  : activeAnchor === "database" ? editingDb
                    : false;
  const activePageMeta = SETTINGS_SEARCH_INDEX.find((item) => item.sub === sub && item.anchor === activeAnchor);

  function beginActiveEdit() {
    if (activeAnchor === "info") setEditingSiteInfo(true);
    else if (activeAnchor === "appearance") setEditingAppearance(true);
    else if (activeAnchor === "ticker") setEditingTicker(true);
    else if (activeAnchor === "nav") { setEditingHomeNav(true); setEditingTabs(true); }
    else if (activeAnchor === "groups") setEditingStockGroups(true);
    else if (activeAnchor === "sources" || activeAnchor === "translation") setEditingSources(true);
    else if (activeAnchor === "trade") setEditingFutu(true);
    else if (activeAnchor === "profile") setEditingProfile(true);
    else if (activeAnchor === "database") setEditingDb(true);
  }
  useEffect(() => {
    const onEditActive = () => beginActiveEdit();
    window.addEventListener("fire:settings-edit-active", onEditActive);
    return () => window.removeEventListener("fire:settings-edit-active", onEditActive);
  }, [activeAnchor]);
  // 把「当前分区是否在编辑」广播给标题栏（铅笔 ↔ 完成图标切换）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("fire:settings-edit-state", { detail: { editing: activeEditState } }));
  }, [activeEditState]);
  // 标题栏点击「完成」时退出当前编辑
  useEffect(() => {
    const onComplete = () => {
      setEditingSiteInfo(false);
      setEditingAppearance(false);
      setEditingTicker(false);
      setEditingHomeNav(false);
      setEditingTabs(false);
      setEditingStockGroups(false);
      setEditingSources(false);
      setEditingFutu(false);
      setEditingProfile(false);
      setEditingDb(false);
    };
    window.addEventListener("fire:settings-edit-complete", onComplete);
    return () => window.removeEventListener("fire:settings-edit-complete", onComplete);
  }, []);
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const importBackupRef = useRef<HTMLInputElement | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const dataTipRef = useRef<HTMLSpanElement | null>(null);
  const [dataTip, setDataTip] = useState<{ top: number; left: number } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [srcMsg, setSrcMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [srcSaving, setSrcSaving] = useState(false);
  const [futuOnline, setFutuOnline] = useState<boolean | null>(null);
  const [futuTest, setFutuTest] = useState<{ busy: boolean; ok?: boolean; msg?: string } | null>(null);
  const [futuQuota, setFutuQuota] = useState<{
    loading: boolean;
    data?: {
      subscription?: { totalUsed: number; remain: number; ownUsed: number; totalQuota: number; ownTotalQuota: number };
      historyKl?: { used: number; remain: number; totalQuota: number };
    } | null;
    ok?: boolean;
    at?: number;
  }>(() => {
    // 保留上一次查询结果：刷新页面不自动查询，但直接显示上次成功的额度
    try {
      const raw = localStorage.getItem("fire:futu-quota");
      if (raw) {
        const saved = JSON.parse(raw) as { data?: unknown; at?: number };
        if (saved?.data && typeof saved.at === "number") {
          return {
            loading: false,
            data: saved.data as {
              subscription?: { totalUsed: number; remain: number; ownUsed: number; totalQuota: number; ownTotalQuota: number };
              historyKl?: { used: number; remain: number; totalQuota: number };
            },
            ok: true,
            at: saved.at
          };
        }
      }
    } catch {
      /* 缓存损坏时忽略 */
    }
    return { loading: false, data: null };
  });

  async function loadFutuQuota() {
    setFutuQuota((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/futu/quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: site.futuHost, port: site.futuPort })
      });
      const data = await res.json().catch(() => null);
      const quota = data?.quota ?? null;
      if (quota) {
        const at = Date.now();
        setFutuQuota({ loading: false, data: quota, ok: true, at });
        try {
          localStorage.setItem("fire:futu-quota", JSON.stringify({ data: quota, at }));
        } catch {
          /* 存储失败不影响本次展示 */
        }
      } else {
        // 未返回新额度时保留上一次查询结果
        setFutuQuota((s) => ({ ...s, loading: false, ok: false }));
      }
    } catch {
      // 查询失败也保留上一次查询结果
      setFutuQuota((s) => ({ ...s, loading: false, ok: false }));
    }
  }

  async function testFutu() {
    setFutuTest({ busy: true });
    try {
      const res = await fetch("/api/futu/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: site.futuHost, port: site.futuPort })
      });
      const data = await res.json().catch(() => null);
      setFutuTest({
        busy: false,
        ok: Boolean(data?.ok),
        msg: data?.message || (res.ok ? "连接成功" : data?.error || "连接失败")
      });
    } catch {
      setFutuTest({ busy: false, ok: false, msg: "连接失败" });
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setFutuOnline(Boolean(data?.data?.futuOpenD?.available));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveStockSources() {
    setSrcSaving(true);
    setSrcMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteApiUrl: site.quoteApiUrl,
          searchApiUrl: site.searchApiUrl,
          chartApiUrl: site.chartApiUrl,
          currencyApiUrl: site.currencyApiUrl,
          earningsApiUrl: site.earningsApiUrl,
          cnEarningsApiUrl: site.cnEarningsApiUrl,
          usLogoApiUrl: site.usLogoApiUrl,
          cnLogoApiUrl: site.cnLogoApiUrl
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setSite((s) => ({ ...s, ...data.settings }));
      captureSaved(data.settings);
      window.dispatchEvent(new Event("fire:settings-updated"));
      setSrcMsg({ type: "ok", text: "股票来源接口已保存，行情 / 财报 / 图标即时生效" });
      showToast("股票来源接口已保存");
    } catch (err) {
      setSrcMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setSrcSaving(false);
    }
  }

  async function saveStockGroups() {
    // 防误清：券商列表为空且当前已有券商时，先二次确认（避免清空所有持仓记录的券商）
    if (stockGroups.length === 0 && (site.groups?.length ?? 0) > 0) {
      if (!confirm("券商列表为空，保存将删除全部券商并清空所有持仓记录的券商，确定要清空吗？")) return;
    }
    setGroupSaving(true);
    setGroupMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups: stockGroups })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setSite((s) => ({ ...s, groups: data.settings.groups }));
      captureSaved(data.settings);
      setStockGroups(data.settings.groups ?? []);
      window.dispatchEvent(new Event("fire:settings-updated"));
      window.dispatchEvent(new Event("fire:records-updated"));
      setGroupMsg({ type: "ok", text: "券商已保存：改名/删除已全局同步到股票记录" });
      showToast("券商已保存");
      setEditingStockGroups(false);
    } catch (err) {
      setGroupMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setGroupSaving(false);
    }
  }

  async function saveDb() {
    setDbSaving(true);
    setDbMsg(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dbType: site.dbType,
          pgHost: site.pgHost,
          pgPort: site.pgPort,
          pgDatabase: site.pgDatabase,
          pgUser: site.pgUser,
          pgPassword: site.pgPassword
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setSite({ ...DEFAULT_SETTINGS, ...data.settings });
      captureSaved(data.settings);
      setDbMsg({ type: "ok", text: `数据库配置已保存（当前类型：${data.settings.dbType === "postgres" ? "PostgreSQL" : "SQLite"}）` });
      showToast("数据库配置已保存");
    } catch (err) {
      setDbMsg({ type: "err", text: err instanceof Error ? err.message : "保存失败" });
    } finally {
      setDbSaving(false);
    }
  }

  async function testDb() {
    setDbTesting(true);
    setDbMsg(null);
    try {
      const res = await fetch("/api/db/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: site.pgHost,
          port: site.pgPort,
          database: site.pgDatabase,
          pgUser: site.pgUser,
          password: site.pgPassword
        })
      });
      const data = await res.json().catch(() => null);
      setDbMsg({
        type: res.ok ? "ok" : "err",
        text: res.ok ? `连接成功：${data?.version ?? ""}` : (data?.error ?? "连接失败")
      });
    } catch {
      setDbMsg({ type: "err", text: "连接失败" });
    } finally {
      setDbTesting(false);
    }
  }

  /* ---------- 修改密码 ---------- */
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwdMsg, setPwdMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [profilePassword, setProfilePassword] = useState("");

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwdMsg(null);
    if (newPassword !== confirmPassword) {
      setPwdMsg({ type: "err", text: "两次输入的新密码不一致" });
      return;
    }
    setPwdBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "修改失败");
      setPwdMsg({ type: "ok", text: "密码修改成功，下次登录请使用新密码" });
      showToast("密码修改成功");
      setOldPassword(""); setNewPassword(""); setConfirmPassword("");
    } catch (err) {
      setPwdMsg({ type: "err", text: err instanceof Error ? err.message : "修改失败" });
    } finally {
      setPwdBusy(false);
    }
  }

  const [clearing, setClearing] = useState(false);
  async function clearAll() {
    if (!confirm(`确定清空全部 ${recordsCount} 条记录吗？该操作不可恢复！`)) return;
    const password = prompt("安全验证：请输入当前密码");
    if (!password) return;
    setClearing(true);
    await onClearAll(password);
    setClearing(false);
  }

  function changeSub(key: SubKey) {
    setSub(key);
    setActiveAnchor(SETTINGS_SEARCH_INDEX.find((x) => x.sub === key)?.anchor || "info");
    window.dispatchEvent(new CustomEvent("fire:navigate", { detail: { tab: "settings", sub: key } }));
  }

  function syncSettingsUrl(nextSub: SubKey, anchor: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("sub", nextSub);
    url.searchParams.set("anchor", anchor);
    window.history.replaceState({}, "", url.toString());
  }

  /* ---------- ⌘K 命令搜索 ---------- */
  const cmdRef = useRef<HTMLInputElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);

  // 命令面板固定在设置窗口内右上角、紧贴搜索按钮下方（保持在窗口内以继承主题变量与深色适配）
  function openCmdPalette() {
    setCmdIndex(0);
    setCmdOpen(true);
    setTimeout(() => cmdRef.current?.focus(), 0);
  }

  const cmdResults = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    if (!q) return [];
    return SETTINGS_SEARCH_INDEX.filter((item) => {
      const hay = `${item.label} ${item.groupLabel} ${item.keywords}`.toLowerCase();
      return [...q].every((ch) => hay.includes(ch)) || hay.includes(q);
    });
  }, [cmdQuery]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCmdPalette();
      } else if (e.key === "Escape") {
        setCmdOpen(false);
        cmdRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 标题栏搜索按钮通过事件唤起 ⌘K 命令搜索（按钮已移至窗口标题栏，由 SettingsWindow 触发）
  useEffect(() => {
    window.addEventListener("fire:settings-cmd-open", openCmdPalette);
    return () => window.removeEventListener("fire:settings-cmd-open", openCmdPalette);
  }, []);

  function jumpTo(item: { sub: SubKey; anchor: string; label: string }) {
    setCmdQuery("");
    setCmdOpen(false);
    changeSub(item.sub);
    setActiveAnchor(item.anchor);
    syncSettingsUrl(item.sub, item.anchor);
    setTimeout(() => {
      const container = contentScrollRef.current;
      const el = document.getElementById(item.anchor);
      if (container && el) {
        const containerTop = container.getBoundingClientRect().top;
        const elTop = el.getBoundingClientRect().top;
        const scrollTo = container.scrollTop + (elTop - containerTop) - 14;
        container.scrollTo({ top: Math.max(0, scrollTo), behavior: "smooth" });
      }
    }, 120);
  }

  const subPills = (extra: string) => (
    <div className={`settings-subnav mb-5 flex flex-wrap items-center gap-1.5 rounded-2xl border border-edge bg-white p-1.5 shadow-card ${extra}`}>
      {visibleSubNav.map((s) => (
        <SubPill
          key={s.key}
          active={sub === s.key}
          icon={<SubNavIcon name={s.key} className="h-[15px] w-[15px]" />}
          label={s.label}
          onClick={() => changeSub(s.key)}
        />
      ))}
    </div>
  );

  const mobileAnchorItems = navGroups.flatMap((group) => group.items).filter((item) => item.sub === sub);
  const mobileAnchorPills = mobileAnchorItems.length > 1 ? (
    <div className="mb-4 flex gap-1.5 overflow-x-auto rounded-xl border border-edge bg-bg-gray/40 p-1.5 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {mobileAnchorItems.map((item) => (
        <button
          key={item.anchor}
          type="button"
          onClick={() => jumpTo(item)}
          className={`flex-none rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors ${activeAnchor === item.anchor ? "bg-white text-ink shadow-sm" : "text-muted hover:bg-brand-hover hover:text-ink"}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="settings-page flex h-full min-h-0 flex-1">
      {showDeleteConfirm && createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowDeleteConfirm(false); setDeleteConfirmText(""); setDeletePassword(""); } }}>
          <div className="w-full max-w-[380px] rounded-2xl border border-edge bg-white p-6 shadow-pop dark:border-[#2a3140] dark:bg-[#1b2029]">
            <h3 className="text-base font-bold text-ink">确认注销账号</h3>
            <p className="mt-2 text-sm text-muted">此操作<strong className="text-up">不可恢复</strong>，将永久删除账号「{user.nickname || user.username}」及全部持仓、订单、分组、偏好等数据。</p>
            <label className="mt-4 block text-xs font-semibold text-muted">请输入登录名「<b className="text-ink">{user.username}</b>」以确认</label>
            <input
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deleteConfirmText.trim() === user.username) doDeleteAccount(); }}
              placeholder={`请输入 ${user.username}`}
              className="mt-1.5 h-10 w-full rounded-lg border border-edge-strong bg-white px-3 text-sm text-ink outline-none placeholder:opacity-40 focus:border-edge-strong dark:bg-[#151a26] dark:border-[#2a3140]"
            />
            <label className="mt-3 block text-xs font-semibold text-muted">当前密码</label>
            <input
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deleteConfirmText.trim() === user.username && deletePassword) doDeleteAccount(); }}
              autoComplete="current-password"
              placeholder="请输入当前密码"
              className="mt-1.5 h-10 w-full rounded-lg border border-edge-strong bg-white px-3 text-sm text-ink outline-none placeholder:opacity-40 focus:border-edge-strong dark:bg-[#151a26] dark:border-[#2a3140]"
            />
            <div className="mt-5 flex justify-end gap-2.5">
              <button type="button" onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(""); setDeletePassword(""); }} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" disabled={deleteConfirmText.trim() !== user.username || !deletePassword} onClick={doDeleteAccount} className="btn btn-ghost btn-sm !text-up disabled:opacity-40">确认注销</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* 紧凑侧栏（桌面客户端风格） */}
      <aside className="sw-sidebar relative hidden w-[184px] flex-none flex-col border-r p-2 md:flex">
        <div className="sw-brand" aria-label="Fire 投资记实">
          <button
            type="button"
            className={`sw-brand-mark select-none ${brandSpinning ? "is-spinning" : ""}`}
            onPointerDown={(e) => { if (e.button === 0) kickBrand(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); kickBrand(); } }}
            aria-label="连续点击让 Fire 转起来"
            style={{ touchAction: "manipulation" }}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <g ref={petalsRef} style={{ transformOrigin: "24px 24px" }}>
                <path
                  className="sw-brand-petals-custom"
                  d="M23.8 7.2c4.1-.2 7.4 1.5 9.3 4.5 4.5-.8 8.7 2.5 9 7.1 3.8 2.6 4.7 8 2 11.8.2 4.7-3.5 8.7-8.2 8.8-2.4 4.2-7.8 5.7-11.8 3-4.1 1.9-9.2-.2-10.8-4.5-4.5-.8-7.3-5.3-5.8-9.6-2.5-3.8-1-9 3-11.1 1-4.5 5.5-7.2 9.9-5.8.8-2.1 1.9-3.5 3.4-4.2Z"
                />
                <path
                  className="sw-brand-petals"
                  d="M24.00 6.00 C24.34 6.31 24.65 6.65 24.96 6.95 C25.26 7.25 25.54 7.55 25.83 7.80 C26.11 8.05 26.37 8.28 26.64 8.44 C26.92 8.61 27.18 8.73 27.47 8.79 C27.76 8.86 28.05 8.86 28.37 8.83 C28.69 8.80 29.02 8.71 29.38 8.61 C29.75 8.51 30.13 8.36 30.54 8.22 C30.94 8.08 31.37 7.91 31.81 7.78 C32.25 7.65 32.71 7.52 33.15 7.44 C33.60 7.37 34.05 7.31 34.48 7.32 C34.90 7.33 35.33 7.39 35.70 7.51 C36.07 7.63 36.42 7.82 36.72 8.05 C37.01 8.29 37.27 8.59 37.47 8.93 C37.67 9.26 37.82 9.66 37.93 10.07 C38.03 10.48 38.08 10.94 38.11 11.39 C38.13 11.84 38.10 12.32 38.07 12.78 C38.04 13.23 37.98 13.69 37.93 14.12 C37.89 14.54 37.82 14.95 37.80 15.33 C37.78 15.70 37.77 16.05 37.81 16.37 C37.86 16.68 37.93 16.97 38.06 17.23 C38.18 17.50 38.36 17.73 38.58 17.96 C38.80 18.19 39.08 18.40 39.39 18.62 C39.69 18.83 40.05 19.04 40.41 19.27 C40.77 19.50 41.18 19.73 41.55 19.99 C41.92 20.25 42.31 20.53 42.65 20.83 C42.99 21.13 43.32 21.46 43.57 21.79 C43.83 22.13 44.05 22.50 44.19 22.87 C44.32 23.23 44.40 23.62 44.40 24.00 C44.40 24.38 44.32 24.77 44.19 25.13 C44.05 25.50 43.83 25.87 43.57 26.21 C43.32 26.54 42.99 26.87 42.65 27.17 C42.31 27.47 41.92 27.75 41.55 28.01 C41.18 28.27 40.77 28.50 40.41 28.73 C40.05 28.96 39.69 29.17 39.39 29.38 C39.08 29.60 38.80 29.81 38.58 30.04 C38.36 30.27 38.18 30.50 38.06 30.77 C37.93 31.03 37.86 31.32 37.81 31.63 C37.77 31.95 37.78 32.30 37.80 32.67 C37.82 33.05 37.89 33.46 37.93 33.88 C37.98 34.31 38.04 34.77 38.07 35.22 C38.10 35.68 38.13 36.16 38.11 36.61 C38.08 37.06 38.03 37.52 37.93 37.93 C37.82 38.34 37.67 38.74 37.47 39.07 C37.27 39.41 37.01 39.71 36.72 39.95 C36.42 40.18 36.07 40.37 35.70 40.49 C35.33 40.61 34.90 40.67 34.48 40.68 C34.05 40.69 33.60 40.63 33.15 40.56 C32.71 40.48 32.25 40.35 31.81 40.22 C31.37 40.09 30.94 39.92 30.54 39.78 C30.13 39.64 29.75 39.49 29.38 39.39 C29.02 39.29 28.69 39.20 28.37 39.17 C28.05 39.14 27.76 39.14 27.47 39.21 C27.18 39.27 26.92 39.39 26.64 39.56 C26.37 39.72 26.11 39.95 25.83 40.20 C25.54 40.45 25.26 40.75 24.96 41.05 C24.65 41.35 24.34 41.69 24.00 42.00 C23.66 42.31 23.31 42.63 22.94 42.89 C22.57 43.15 22.18 43.40 21.79 43.57 C21.41 43.75 21.00 43.88 20.61 43.93 C20.22 43.98 19.83 43.97 19.46 43.89 C19.09 43.80 18.73 43.64 18.40 43.43 C18.08 43.21 17.77 42.92 17.49 42.59 C17.22 42.27 16.98 41.87 16.76 41.48 C16.54 41.08 16.36 40.64 16.19 40.22 C16.02 39.80 15.88 39.35 15.74 38.95 C15.59 38.55 15.47 38.15 15.33 37.80 C15.18 37.46 15.04 37.14 14.87 36.87 C14.69 36.60 14.50 36.38 14.27 36.20 C14.04 36.01 13.78 35.88 13.48 35.77 C13.18 35.66 12.84 35.59 12.47 35.53 C12.10 35.46 11.69 35.43 11.26 35.38 C10.84 35.33 10.38 35.30 9.93 35.22 C9.48 35.15 9.01 35.07 8.57 34.95 C8.14 34.82 7.70 34.67 7.32 34.48 C6.94 34.28 6.59 34.05 6.31 33.78 C6.02 33.51 5.78 33.19 5.62 32.85 C5.46 32.51 5.36 32.13 5.32 31.74 C5.29 31.35 5.33 30.92 5.41 30.51 C5.49 30.09 5.65 29.65 5.82 29.24 C5.99 28.82 6.23 28.40 6.45 28.01 C6.67 27.61 6.94 27.22 7.16 26.86 C7.38 26.50 7.62 26.15 7.80 25.83 C7.98 25.50 8.14 25.19 8.24 24.88 C8.34 24.58 8.40 24.29 8.40 24.00 C8.40 23.71 8.34 23.42 8.24 23.12 C8.14 22.81 7.98 22.50 7.80 22.17 C7.62 21.85 7.38 21.50 7.16 21.14 C6.94 20.78 6.67 20.39 6.45 19.99 C6.23 19.60 5.99 19.18 5.82 18.76 C5.65 18.35 5.49 17.91 5.41 17.49 C5.33 17.08 5.29 16.65 5.32 16.26 C5.36 15.87 5.46 15.49 5.62 15.15 C5.78 14.81 6.02 14.49 6.31 14.22 C6.59 13.95 6.94 13.72 7.32 13.52 C7.70 13.33 8.14 13.18 8.57 13.05 C9.01 12.93 9.48 12.85 9.93 12.78 C10.38 12.70 10.84 12.67 11.26 12.62 C11.69 12.57 12.10 12.54 12.47 12.47 C12.84 12.41 13.18 12.34 13.48 12.23 C13.78 12.12 14.04 11.99 14.27 11.80 C14.50 11.62 14.69 11.40 14.87 11.13 C15.04 10.86 15.18 10.54 15.33 10.20 C15.47 9.85 15.59 9.45 15.74 9.05 C15.88 8.65 16.02 8.20 16.19 7.78 C16.36 7.36 16.54 6.92 16.76 6.52 C16.98 6.13 17.22 5.73 17.49 5.41 C17.77 5.08 18.08 4.79 18.40 4.57 C18.73 4.36 19.09 4.20 19.46 4.11 C19.83 4.03 20.22 4.02 20.61 4.07 C21.00 4.12 21.41 4.25 21.79 4.43 C22.18 4.60 22.57 4.85 22.94 5.11 C23.31 5.37 23.66 5.69 24.00 6.00 Z"
                />
              </g>
              <g ref={brandInnerRef} style={{ transformOrigin: "24px 24px" }}>
                <g transform="translate(24 24) scale(0.84) translate(-24 -24)">
                  <path className="sw-brand-trend" d="m17.5 27 4-4 3.2 2.7 6-7" />
                  <path className="sw-brand-arrow" d="M27.7 18.7h3.2v3.2" />
                </g>
              </g>
            </svg>
          </button>
        </div>
        {navGroups.map((g) => (
          <div key={g.label} className="sw-nav-group">
            <p className="sw-nav-group-title">{g.label}</p>
            {g.items.map((item) => (
              <button
                key={item.sub + item.anchor}
                type="button"
                onClick={() => jumpTo(item)}
                className={`sw-nav-item ${sub === item.sub && activeAnchor === item.anchor ? "is-active" : ""}`}
              >
                <SubNavIcon name={SETTINGS_ANCHOR_ICONS[item.anchor] || item.sub} className="h-[14px] w-[14px]" />
                {item.label}
                {item.sub === "api" && (
                  <span
                    role="link"
                    title="打开 API 规范文档"
                    onClick={(e) => { e.stopPropagation(); window.open("/api-docs", "_blank"); }}
                    className="sw-nav-ext"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 5h5v5" /><path d="m19 5-8 8" /></svg>
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        <div className="sw-side-foot">
          <span className="sw-avatar-wrap">
            {user.avatar ? (
              <img src={user.avatar} alt="" className="sw-avatar-img" />
            ) : (
              <span className="sw-avatar">{user.nickname?.slice(0, 1) || user.username.slice(0, 1)}</span>
            )}
            <i className="sw-online" />
          </span>
          <div>
            <b>{user.nickname || user.username}</b>
            <span>{user.role === "admin" ? "管理员" : "用户"}</span>
          </div>
        </div>
      </aside>

      {cmdOpen && (
        <div
          role="dialog"
          aria-label="搜索设置"
          className="sw-cmd-pop fixed right-4 top-[52px] z-[200] w-[min(240px,calc(100vw-32px))] overflow-hidden rounded-xl border shadow-pop md:right-5 md:w-[180px]"
          style={{ borderColor: "var(--sv-card-border)", background: "var(--sv-card)", color: "var(--sv-text)" }}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: "var(--sv-border)" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-[13px] w-[13px] flex-none opacity-60"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              ref={cmdRef}
              value={cmdQuery}
              autoFocus
              onChange={(e) => { setCmdQuery(e.target.value); setCmdIndex(0); }}
              onBlur={() => setTimeout(() => setCmdOpen(false), 160)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && cmdResults.length > 0) { e.preventDefault(); setCmdIndex((i) => Math.min(i + 1, cmdResults.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setCmdIndex((i) => Math.max(i - 1, 0)); }
                else if (e.key === "Enter" && cmdResults[cmdIndex]) { e.preventDefault(); jumpTo(cmdResults[cmdIndex]); }
              }}
              role="combobox"
              aria-label="搜索设置项"
              aria-controls="fire-settings-command-results"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={cmdResults[cmdIndex] ? `fire-settings-command-option-${cmdIndex}` : undefined}
              placeholder="搜索设置…"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-50"
              style={{ color: "var(--sv-text)" }}
            />
          </div>
          <div id="fire-settings-command-results" role="listbox" className="max-h-[min(240px,calc(100vh-110px))] overflow-y-auto py-1">
            {cmdResults.length === 0 ? (
              <p className="px-3 py-2 text-[11px] opacity-60">{cmdQuery.trim() ? "没有匹配的设置项" : "输入名称查找设置项"}</p>
            ) : cmdResults.map((item, i) => (
              <button
                id={`fire-settings-command-option-${i}`}
                key={item.sub + item.anchor}
                type="button"
                onPointerDown={(e) => { e.preventDefault(); jumpTo(item); }}
                onPointerEnter={() => setCmdIndex(i)}
                role="option"
                aria-selected={i === cmdIndex}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
                style={i === cmdIndex ? { background: "var(--sv-hover-bg)" } : undefined}
              >
                <SubNavIcon name={SETTINGS_ANCHOR_ICONS[item.anchor] || item.sub} className="h-3.5 w-3.5 opacity-70" />
                <span className="font-semibold">{item.label}</span>
                <span className="ml-auto text-[10px] opacity-60">{item.groupLabel}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sw-content flex min-w-0 flex-1 flex-col">
        {/* 内容头部 */}
        <div className="sw-page-head flex flex-none items-center justify-between gap-3 px-6 pb-3 pt-5">
          <div className="min-w-0">
            <h2 className="text-[16px] font-bold tracking-[-0.01em] text-ink dark:text-[#e8e8e8]">设置</h2>
            <p className="mt-0.5 truncate text-[11.5px] text-faint">{activePageMeta?.label || activeSubMeta?.label} · {activeEditState ? "正在编辑" : "只读浏览"}</p>
          </div>
        </div>

        <div ref={contentScrollRef} className="sw-content-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-8">
          {/* 移动端横向分类 */}
          {subPills("md:hidden")}
          {mobileAnchorPills}

          <div key={sub} className="tab-panel">
            {!isAdminUser && ADMIN_SUB_KEYS.has(sub) && (
              <div className="rounded-card border border-edge bg-white p-10 text-center shadow-card">
                <p className="text-sm font-semibold text-ink">没有访问权限</p>
                <p className="mt-1 text-xs text-muted">该设置仅管理员可用</p>
              </div>
            )}
            {/* ===== 网站设置 ===== */}
            {sub === "site" && isAdminUser && (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-5">
                  <SettingsSection
                    icon="info"
                    title="站点信息"
                    desc="站点在浏览器标签页与首页展示的基础信息"
                    id="info"
                    titleAction={!editingSiteInfo ? (
                      <button type="button" onClick={() => setEditingSiteInfo(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑站点信息" aria-label="编辑站点信息">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                      </button>
                    ) : undefined}
                    action={editingSiteInfo ? <button type="button" onClick={() => setEditingSiteInfo(false)} className="btn btn-line btn-sm">完成</button> : undefined}
                  >
                    <div className="flex flex-col">
                      <div className="sw-row">
                        <div className="sw-row-label"><b>网站标题</b></div>
                        <input className={`sw-row-input ${editingSiteInfo ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.title} readOnly={!editingSiteInfo} onChange={(e) => setSiteField("title", e.target.value)} placeholder="显示在浏览器标签页与首页" />
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>网站域名</b></div>
                        <input className={`sw-row-input ${editingSiteInfo ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.domain} readOnly={!editingSiteInfo} onChange={(e) => setSiteField("domain", e.target.value)} placeholder="如：fire.example.com" />
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>允许新用户注册</b><span>关闭后仅管理员可创建账号</span></div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={site.allowRegister}
                          disabled={!editingSiteInfo}
                          onClick={() => setSite((s) => ({ ...s, allowRegister: !s.allowRegister }))}
                          className={`relative h-6 w-11 flex-none rounded-full transition-colors duration-200 disabled:cursor-default ${site.allowRegister ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}
                        >
                          <span
                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full shadow-sm transition-transform duration-200 ${site.allowRegister ? "translate-x-5" : ""}`}
                            style={{ backgroundColor: "#ffffff" }}
                          />
                        </button>
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>页脚简介文字</b></div>
                        <input className={`sw-row-input ${editingSiteInfo ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.footerDesc} readOnly={!editingSiteInfo} onChange={(e) => setSiteField("footerDesc", e.target.value)} placeholder="如：一个轻量、免费的股票记录网站" />
                      </div>
                    </div>
                  </SettingsSection>

                    <SettingsSection
                      icon="image"
                      title="网站形象"
                      desc="Logo、字体与背景图，替换后删除旧文件保持唯一"
                      id="appearance"
                      action={
                        <div className="flex items-center gap-2">
                          {editingAppearance && (
                            <button type="button" onClick={() => setEditingAppearance(false)} className="btn btn-line btn-sm">完成</button>
                          )}
                          <button
                            type="button"
                            disabled={blockSaving.brand || !editingAppearance}
                            onClick={resetBrand}
                            className="btn btn-line btn-sm disabled:opacity-60"
                          >
                            重置
                          </button>
                        </div>
                      }
                      titleAction={!editingAppearance ? (
                        <button type="button" onClick={() => setEditingAppearance(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑网站形象" aria-label="编辑网站形象">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        </button>
                      ) : undefined}
                    >
                      <div className="flex flex-col">
                        <SwMediaField
                          label="网站图标"
                          editable={editingAppearance}
                          desc="Favicon · 支持上传或直接粘贴图片链接，自动预览"
                          value={site.ico}
                          onChange={(v) => setSiteField("ico", v)}
                          placeholder="或粘贴图片链接"
                          inputRef={icoRef}
                          accept="image/jpeg,image/png,image/gif,image/webp,.ico,.svg"
                          onUpload={(f) => uploadSiteFile("ico", f).then((url) => { if (url) setSiteField("ico", url); })}
                          onClear={() => setSiteField("ico", "")}
                          kind="icon"
                        />
                        <SwMediaField
                          label="首页 Logo"
                          editable={editingAppearance}
                          desc="左上角品牌 Logo · 支持上传或直接粘贴图片链接，自动预览"
                          value={site.siteLogo}
                          onChange={(v) => setSiteField("siteLogo", v)}
                          placeholder="或粘贴图片链接"
                          inputRef={logoRef}
                          accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,.svg"
                          onUpload={(f) => uploadLogo(f).then((url) => { if (url) setSiteField("siteLogo", url); })}
                          onClear={() => setSiteField("siteLogo", "")}
                          kind="logo"
                        />
                        <SwMediaField
                          label="网站背景"
                          editable={editingAppearance}
                          desc="首页背景图 · 支持上传或直接粘贴图片链接，自动预览"
                          value={site.homepageBg}
                          onChange={(v) => setSiteField("homepageBg", v)}
                          placeholder="或粘贴图片链接"
                          inputRef={bgRef}
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          onUpload={(f) => uploadSiteFile("background", f).then((url) => { if (url) setSiteField("homepageBg", url); })}
                          onClear={() => setSiteField("homepageBg", "")}
                          kind="bg"
                        />
                        <SwMediaField
                          label="登录页左侧图"
                          editable={editingAppearance}
                          desc="登录弹窗左侧配图 · 上传后登录页优先展示，未上传时使用品牌默认图"
                          value={site.loginSideImage}
                          onChange={(v) => setSiteField("loginSideImage", v)}
                          placeholder="或粘贴图片链接"
                          inputRef={loginImgRef}
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          onUpload={(f) => uploadLoginImage(f).then((url) => { if (url) setSiteField("loginSideImage", url); })}
                          onClear={() => setSiteField("loginSideImage", "")}
                          kind="bg"
                        />
                      </div>
                    </SettingsSection>

                    <SettingsSection
                      icon="stocks"
                      title="首页指数设置"
                      desc="首页顶部指数行情条的指数与轮换间隔"
                      className="xl:col-span-2"
                      id="ticker"
                      collapsible
                      defaultOpen={false}
                      storageKey="homepage-ticker"
                      titleAction={!editingTicker ? (
                        <button type="button" onClick={() => setEditingTicker(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑首页指数" aria-label="编辑首页指数">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                        </button>
                      ) : undefined}
                      action={editingTicker ? <button type="button" onClick={() => setEditingTicker(false)} className="btn btn-line btn-sm">完成</button> : undefined}
                    >
                      <div className="settings-compact-list mb-3 flex flex-wrap items-center gap-3 rounded-[10px] bg-bg-gray/60 px-3 py-2.5">
                        <span className="text-[13px] font-semibold text-ink-2">轮换间隔</span>
                        <input
                          type="number"
                          min={3}
                          max={60}
                          value={site.ticker.interval}
                          readOnly={!editingTicker}
                          onChange={(e) => setTickerInterval(Number(e.target.value))}
                          className={`h-[34px] w-20 rounded-[8px] px-2.5 text-sm tabular-nums outline-none transition-shadow ${editingTicker ? "border border-edge-strong bg-white focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]" : "pointer-events-none border border-transparent bg-transparent"}`}
                        />
                        <span className="text-xs text-muted">秒（3 - 60）</span>
                        <span className="ml-auto text-xs text-faint">共 {site.ticker.items.length} 个指数</span>
                      </div>

                      <div className="settings-compact-list hidden grid-cols-[auto_auto_minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_auto] items-center gap-2 px-2 pb-1 text-[11px] font-semibold text-faint sm:grid">
                        <span />
                        <span />
                        <span>名称</span>
                        <span>市场</span>
                        <span>东方财富 secid</span>
                        <span />
                      </div>

                      <div className="settings-compact-list flex flex-col gap-2">
                        {site.ticker.items.slice(0, showAllTicker ? site.ticker.items.length : 5).map((item, i) => (
                          <div
                            key={item.key}
                            draggable={editingTicker}
                            onDragStart={(e) => {
                              tickerDragIndex.current = i;
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => dropTickerRow(i)}
                            onDragEnd={() => {
                              tickerDragIndex.current = null;
                            }}
                            className="grid grid-cols-[auto_auto_minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_auto] items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 p-2 transition-colors"
                            title={editingTicker ? "按住拖动排序" : undefined}
                          >
                            <svg viewBox="0 0 24 24" fill="currentColor" className={`h-4 w-4 text-faint ${editingTicker ? "cursor-grab active:cursor-grabbing" : "opacity-0"}`}>
                              <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                              <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                              <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                            </svg>
                            <MarketIcon market={item.market} size={20} />
                            <input
                              value={item.label}
                              readOnly={!editingTicker}
                              onChange={(e) => setTickerItem(i, { label: e.target.value })}
                              placeholder="指数名称"
                              className={`h-[34px] min-w-0 rounded-[8px] px-2.5 text-sm font-semibold text-ink outline-none transition-shadow ${editingTicker ? "border border-edge-strong bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`}
                            />
                            <input
                              value={item.market}
                              readOnly={!editingTicker}
                              onChange={(e) => setTickerItem(i, { market: e.target.value.trim().toUpperCase() })}
                              placeholder="如 US / HK"
                              list="ticker-market-options"
                              className={`h-[34px] min-w-0 rounded-[8px] px-2.5 text-sm text-ink outline-none transition-shadow ${editingTicker ? "border border-edge-strong bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`}
                            />
                            <input
                              value={item.secid}
                              readOnly={!editingTicker}
                              onChange={(e) => setTickerItem(i, { secid: e.target.value })}
                              placeholder="如 100.DJIA"
                              className={`h-[34px] min-w-0 rounded-[8px] px-2.5 font-mono text-xs text-ink outline-none transition-shadow ${editingTicker ? "border border-edge-strong bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`}
                            />
                            {editingTicker ? <button
                              type="button"
                              onClick={() => removeTickerItem(i)}
                              title="删除指数"
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white"
                            >
                              <DeleteIcon size={14} />
                            </button> : <span className="h-7 w-7" />}
                          </div>
                        ))}
                      </div>
                      {site.ticker.items.length > 5 && (
                        <button type="button" onClick={() => setShowAllTicker((value) => !value)} className="mt-3 inline-flex self-start items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink" aria-expanded={showAllTicker}>
                          {showAllTicker ? "收起" : `更多（${site.ticker.items.length - 5}）`}
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform ${showAllTicker ? "rotate-180" : ""}`}><path d="m5 7.5 5 5 5-5" /></svg>
                        </button>
                      )}
                      <datalist id="ticker-market-options">
                        {["US", "HK", "CN", "JP", "KR", "SG", "TW", "TH", "IN", "AU", "DE", "GB", "FR"].map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      {editingTicker && <button type="button" onClick={addTickerItem} className="btn btn-line btn-sm mt-3">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
                          <path d="M12 5v14" /><path d="M5 12h14" />
                        </svg>
                        添加指数
                      </button>}
                    </SettingsSection>

                    <SettingsSection
                      icon="list"
                      title="首页导航"
                      desc="首页入口菜单，可拖动排序、启停"
                      className="xl:col-span-2"
                      id="nav"
                      collapsible
                      defaultOpen={false}
                      storageKey="home-nav"
                      titleAction={!editingHomeNav ? (
                        <button type="button" onClick={() => setEditingHomeNav(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑首页导航" aria-label="编辑首页导航">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                        </button>
                      ) : undefined}
                      action={editingHomeNav ? <button type="button" onClick={() => setEditingHomeNav(false)} className="btn btn-line btn-sm">完成</button> : undefined}
                    >
                      <div className="settings-compact-list flex flex-col gap-2">
                        {(site.homeNav || []).slice(0, showAllHomeNav ? (site.homeNav || []).length : 5).map((item) => (
                          <div
                            key={item.key}
                            draggable={editingHomeNav}
                            onDragStart={(e) => {
                              navDragIndex.current = (site.homeNav || []).findIndex((n) => n.key === item.key);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => dropNavRow((site.homeNav || []).findIndex((n) => n.key === item.key))}
                            onDragEnd={() => {
                              navDragIndex.current = null;
                            }}
                            className={`group rounded-[12px] border border-edge bg-white transition-[border-color,box-shadow] duration-200 hover:border-edge-strong/50 hover:shadow-[0_4px_14px_rgba(107,114,128,.10)] ${editingHomeNav ? "flex flex-col gap-2 p-3" : "flex min-h-[52px] items-center gap-3 px-3 py-2 max-sm:flex-wrap"}`}
                            title={editingHomeNav ? "按住拖动排序" : undefined}
                          >
                            {editingHomeNav ? <><div className="flex items-center justify-between">
                              <svg viewBox="0 0 24 24" fill="currentColor" className={`h-4 w-4 text-faint ${editingHomeNav ? "cursor-grab active:cursor-grabbing" : "opacity-0"}`}>
                                <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                                <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                                <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                              </svg>
                              {editingHomeNav ? (
                                <label className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-ink-2">
                                  <input type="checkbox" checked={item.enabled} onChange={(e) => setNav(item.key, { enabled: e.target.checked })} className="h-4 w-4 cursor-pointer accent-[#3297f6]" />显示
                                </label>
                              ) : null}
                            </div>
                            <>
                              <input value={item.label} onChange={(e) => setNav(item.key, { label: e.target.value })} placeholder="名称" className="h-[34px] w-full rounded-[8px] border border-transparent bg-transparent px-2 text-sm font-semibold text-ink outline-none transition-all duration-200 hover:border-edge-strong hover:bg-white focus:border-edge-strong focus:bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)]" />
                              <input value={item.href} onChange={(e) => setNav(item.key, { href: e.target.value })} placeholder="链接，如 #preview / /records" className="h-[32px] w-full rounded-[8px] border border-edge bg-bg-gray/60 px-2.5 font-mono text-[11px] text-muted outline-none transition-all duration-200 hover:border-edge-strong hover:bg-white focus:border-edge-strong focus:bg-white focus:text-ink" />
                            </></> : <><strong className="min-w-0 flex-1 truncate text-sm text-ink">{item.label}</strong><span className="w-[180px] truncate font-mono text-[11px] text-muted max-sm:order-3 max-sm:w-full">{item.href}</span><span className="flex-none text-[11px] font-medium text-muted">{item.enabled ? "已显示" : "已隐藏"}</span></>}
                          </div>
                        ))}
                      </div>
                      {(site.homeNav || []).length > 5 && (
                        <button type="button" onClick={() => setShowAllHomeNav((value) => !value)} className="mt-3 inline-flex self-start items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink" aria-expanded={showAllHomeNav}>
                          {showAllHomeNav ? "收起" : `更多（${(site.homeNav || []).length - 5}）`}
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform ${showAllHomeNav ? "rotate-180" : ""}`}><path d="m5 7.5 5 5 5-5" /></svg>
                        </button>
                      )}
                    </SettingsSection>
                </div>

                {/* 应用导航与首页导航归入同一侧栏入口，避免切换后残留在其他设置项下。 */}
                {activeAnchor === "nav" && <SettingsSection
                  icon="list"
                  title="应用导航菜单"
                  desc="侧栏与移动端入口，可调整默认页、图标、名称和顺序"
                  collapsible
                  defaultOpen={false}
                  storageKey="nav-tabs"
                  titleAction={!editingTabs ? (
                    <button type="button" onClick={() => setEditingTabs(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑应用导航" aria-label="编辑应用导航">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={
                    editingTabs ? <button
                      type="button"
                      disabled={blockSaving.tabs}
                      onClick={async () => {
                        const saved = await saveBlock("tabs", { tabs }, "导航菜单已保存");
                        if (saved) setEditingTabs(false);
                      }}
                      className="btn btn-line btn-sm disabled:opacity-60"
                    >
                      {blockSaving.tabs ? "保存中…" : "保存"}
                    </button> : undefined
                  }
                >
                  <div className="settings-compact-list flex flex-col gap-2">
                    {tabs.slice(0, showAllTabs ? tabs.length : 5).map((t, i) => (
                      <div
                        key={t.key}
                        draggable={editingTabs}
                        onDragStart={(e) => {
                          tabDragIndex.current = i;
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => dropTabRow(i)}
                        onDragEnd={() => {
                          tabDragIndex.current = null;
                        }}
                        className={editingTabs ? "grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 p-2 transition-colors sm:grid-cols-[auto_auto_minmax(0,1fr)_140px_auto_auto] sm:gap-2.5" : "flex min-h-[50px] items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 px-3 py-2 max-sm:flex-wrap"}
                        title={editingTabs ? "拖动排序" : undefined}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor" className={`h-3.5 w-3.5 flex-none text-faint ${editingTabs ? "cursor-grab" : "hidden"}`}>
                          <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                          <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                          <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                        </svg>
                        {editingTabs ? <button
                          type="button"
                          disabled={!editingTabs}
                          onClick={() => setTabs((prev) => prev.map((x) => ({ ...x, default: x.key === t.key })))}
                          className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 transition-colors hover:bg-brand-light disabled:pointer-events-none"
                          style={{ borderColor: t.default ? "currentColor" : "#c9ced8", background: t.default ? "currentColor" : "transparent" }}
                          title={t.default ? "当前默认页" : "设为默认打开页"}
                        >
                          {t.default && (
                            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m5 13 4 4L19 7" /></svg>
                          )}
                        </button> : <span className="inline-flex h-5 w-5 flex-none items-center justify-center">{t.default && <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-ink"><path d="m4 10 3.5 3.5L16 5.5" /></svg>}</span>}
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            disabled={!editingTabs || !!blockSaving[`nav-icon:${t.key}`]}
                            onClick={() => navIconRefs.current[t.key]?.click()}
                            className="group relative flex h-7 w-7 flex-none items-center justify-center overflow-hidden rounded-[9px] border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] disabled:cursor-default dark:bg-[#1c1c1e]"
                            title={`上传/更换「${t.label}」导航图标`}
                          >
                            <SafeAssetImage
                              src={assetIcons[t.key.toUpperCase()]}
                              fallback={<span className="flex h-full w-full items-center justify-center text-muted">{NAV_ICONS[t.key] ?? null}</span>}
                              className="h-full w-full object-contain p-0.5"
                            />
                            {editingTabs && <span className="absolute inset-0 flex items-center justify-center rounded-[9px] bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                              {blockSaving[`nav-icon:${t.key}`] ? (
                                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                  <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                                  <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
                                  <circle cx="12" cy="13" r="3" />
                                </svg>
                              )}
                            </span>}
                          </button>
                          <input
                            ref={(el) => {
                              navIconRefs.current[t.key] = el;
                            }}
                            type="file"
                            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void uploadNavIcon(f, t.key, t.label);
                              e.target.value = "";
                            }}
                          />
                          <input
                            value={t.label}
                            readOnly={!editingTabs}
                            onChange={(e) => setTabs((prev) => prev.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))}
                            className={`h-[34px] min-w-0 flex-1 rounded-[8px] px-3 text-sm outline-none transition-shadow ${editingTabs ? "border border-edge-strong bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)]" : "pointer-events-none !border-transparent !bg-transparent !shadow-none font-semibold"}`}
                          />
                        </div>
                        <div className={editingTabs ? "col-span-4 flex items-center gap-2 sm:col-span-3 sm:min-w-0" : "flex w-[180px] flex-none items-center gap-2 max-sm:w-full max-sm:pl-7"}>
                          <input
                            value={t.url || `/${t.key}`}
                            readOnly={!editingTabs}
                            onChange={(e) => setTabs((prev) => prev.map((x, idx) => (idx === i ? { ...x, url: e.target.value.trim() } : x)))}
                            placeholder={`/${t.key}`}
                            title="独立 URL，如 /holdings"
                            className={`h-[34px] min-w-0 flex-1 rounded-[8px] px-2.5 font-mono text-xs outline-none transition-shadow ${editingTabs ? "border border-edge-strong bg-bg-gray/40 focus:bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)]" : "pointer-events-none !border-transparent !bg-transparent !shadow-none text-muted"}`}
                          />
                          {editingTabs && <button type="button" disabled={i === 0} onClick={() => moveTab(i, -1)} className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-brand-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35" title="上移">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m18 15-6-6-6 6" /></svg>
                          </button>}
                          {editingTabs && <button type="button" disabled={i === tabs.length - 1} onClick={() => moveTab(i, 1)} className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-[8px] border border-edge text-muted transition-colors hover:bg-brand-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35" title="下移">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m6 9 6 6 6-6" /></svg>
                          </button>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {tabs.length > 5 && (
                    <button type="button" onClick={() => setShowAllTabs((value) => !value)} className="mt-3 inline-flex self-start items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink" aria-expanded={showAllTabs}>
                      {showAllTabs ? "收起" : `更多（${tabs.length - 5}）`}
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform ${showAllTabs ? "rotate-180" : ""}`}><path d="m5 7.5 5 5 5-5" /></svg>
                    </button>
                  )}
                </SettingsSection>}

              </div>
            )}

            {/* ===== 股票设置：券商管理 ===== */}
            {sub === "stocks" && isAdminUser && (
              <div className="flex flex-col gap-6">
                <SettingsSection
                  icon="tag"
                  title="券商分组"
                  desc="持仓记录所属券商；拖动排序，点名称可编辑别名"
                  id="groups"
                  titleAction={!editingStockGroups ? (
                    <button
                      type="button"
                      disabled={!groupsLoaded}
                      onClick={() => setEditingStockGroups(true)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink disabled:opacity-40"
                      title="编辑券商分组"
                      aria-label="编辑券商分组"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                      </svg>
                    </button>
                  ) : undefined}
                  action={
                    editingStockGroups ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={groupSaving}
                          onClick={() => {
                            setStockGroups(site.groups ?? []);
                            setEditingStockGroups(false);
                            setGroupMsg(null);
                          }}
                          className="btn btn-ghost btn-sm disabled:opacity-60"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={groupSaving || !groupsLoaded}
                          onClick={saveStockGroups}
                          className="btn btn-line btn-sm disabled:opacity-60"
                          title={!groupsLoaded ? "券商列表加载中…" : undefined}
                        >
                          {groupSaving ? "保存中…" : !groupsLoaded ? "加载中…" : "保存"}
                        </button>
                      </div>
                    ) : undefined
                  }
                >
                  <div className="settings-compact-list flex flex-col gap-2">
                    {stockGroups.slice(0, showAllStockGroups ? stockGroups.length : 3).map((g, i) => (
                      <div
                        key={g.id}
                        draggable={editingStockGroups}
                        onDragStart={(e) => {
                          groupDragIndex.current = i;
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => dropGroupRow(i)}
                        onDragEnd={() => {
                          groupDragIndex.current = null;
                        }}
                        className="group relative flex items-center gap-2.5 rounded-[14px] border border-edge bg-white p-3 transition-[border-color,box-shadow] duration-300 ease-out hover:border-edge-strong/50 hover:shadow-[0_6px_20px_rgba(107,114,128,.14)]"
                        title={editingStockGroups ? "按住拖动排序" : undefined}
                      >
                        {editingStockGroups && (
                          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 flex-none cursor-grab text-faint active:cursor-grabbing">
                            <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                            <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                            <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                          </svg>
                        )}
                        {brokerIconOf(g.id) ? (
                          <img src={brokerIconOf(g.id)} alt="" className="h-9 w-9 flex-none rounded-[10px] object-cover" />
                        ) : (
                          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-edge bg-bg-gray text-xs font-bold text-muted">
                            {(g.name || "?").slice(0, 1)}
                          </span>
                        )}
                        {editingStockGroups ? (
                          <div className="flex min-w-0 flex-1 items-center gap-2 max-sm:flex-wrap">
                          <input
                            value={g.name}
                            onChange={(e) => setStockGroups((prev) => prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))}
                            placeholder="券商名称"
                            className="h-[34px] min-w-[150px] flex-1 rounded-[8px] border border-transparent bg-transparent px-2 text-sm font-semibold text-ink outline-none transition-all duration-200 placeholder:font-normal placeholder:text-faint hover:border-edge-strong hover:bg-white dark:hover:bg-[#151a26] focus:border-edge-strong focus:bg-white dark:focus:bg-[#151a26] focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)]"
                            title="直接输入修改券商名称"
                          />
                          <input
                            value={g.alias ?? ""}
                            onChange={(e) => setStockGroups((prev) => prev.map((x, idx) => (idx === i ? { ...x, alias: e.target.value } : x)))}
                            placeholder="别名，如 IBKR"
                            className="h-[34px] w-[180px] min-w-[120px] rounded-[8px] border border-edge bg-bg-gray/40 px-2.5 text-xs text-muted outline-none transition-all duration-200 placeholder:text-faint hover:border-edge-strong hover:bg-white max-sm:flex-1 dark:hover:bg-[#151a26] focus:border-edge-strong focus:bg-white dark:focus:bg-[#151a26]"
                            title="券商别名"
                          />
                          </div>
                        ) : (
                          <div className="flex min-w-0 flex-1 items-baseline gap-4 px-1">
                            <strong className="truncate text-sm font-semibold text-ink">{g.name || "未命名券商"}</strong>
                            <span className="truncate text-xs text-muted">{g.alias || "—"}</span>
                          </div>
                        )}
                        {editingStockGroups && (
                          <button
                            type="button"
                            onClick={() => setStockGroups((prev) => prev.filter((x) => x.id !== g.id))}
                            className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg text-faint opacity-0 transition-all duration-200 hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white group-hover:opacity-100 focus:opacity-100"
                            title="删除券商"
                          >
                            <DeleteIcon size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                    {stockGroups.length === 0 && (
                      <p className="col-span-full rounded-[14px] border border-dashed border-edge-strong py-8 text-center text-xs text-faint">
                        还没有券商，点下方「添加券商」创建。
                      </p>
                    )}
                  </div>
                  {stockGroups.length > 3 && (
                    <button
                      type="button"
                      onClick={() => setShowAllStockGroups((value) => !value)}
                      className="mt-3 inline-flex self-start items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                      aria-expanded={showAllStockGroups}
                    >
                      {showAllStockGroups ? "收起" : `更多（${stockGroups.length - 3}）`}
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform duration-200 ${showAllStockGroups ? "rotate-180" : ""}`}>
                        <path d="m5 7.5 5 5 5-5" />
                      </svg>
                    </button>
                  )}
                  {editingStockGroups && (
                    <button type="button" onClick={addGroup} className="btn btn-ghost btn-sm mt-4 self-start">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                      添加券商
                    </button>
                  )}
                  {groupMsg && (
                    <p className={`rounded-[10px] px-3.5 py-2.5 text-[13px] ${groupMsg.type === "ok" ? "bg-brand-light text-brand-deep" : "bg-up-bg text-up"}`}>
                      {groupMsg.text}
                    </p>
                  )}
                </SettingsSection>

                {/* 股票来源接口（自网站管理移入） */}
                <SettingsSection
                  icon="plug"
                  title="股票来源接口"
                  desc="行情、财报与图标外部数据源，可在不升级情况下调整"
                  id="sources"
                  collapsible
                  defaultOpen={false}
                  storageKey="stock-sources"
                  titleAction={!editingSources ? (
                    <button type="button" onClick={() => setEditingSources(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑股票来源接口" aria-label="编辑股票来源接口">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingSources ? <button type="button" onClick={() => setEditingSources(false)} className="btn btn-line btn-sm">完成</button> : undefined}
                >
                  <div className="flex flex-col">
                    {([["行情", ["quoteApiUrl", "searchApiUrl", "chartApiUrl", "currencyApiUrl"]], ["财报", ["earningsApiUrl", "cnEarningsApiUrl"]], ["图标", ["usLogoApiUrl", "cnLogoApiUrl"]], ["交易广场数据源", ["trumpArchiveApiUrl"]]] as const).map(([label, keys]) => {
                      const fields = SOURCE_FIELDS.filter((f) => (keys as readonly string[]).includes(f.key));
                      if (!fields.length) return null;
                      return (
                        <div key={label}>
                          <p className={`subhead ${label.startsWith("翻译服务") ? "mt-6 border-t border-edge pt-5 text-brand-deep" : ""}`}>{label}</p>
                          {fields.map((f) => {
                            const value = (site as unknown as Record<string, string>)[f.key] || f.placeholder;
                            return (
                              <div key={f.key} className="sw-row">
                                <div className="sw-row-label"><b>{f.name}</b><span>{f.desc}</span></div>
                                <div className="ctrl">
                                  {editingSources ? (
                                    <input
                                      className="sw-row-input"
                                      value={value}
                                      title={value}
                                      onChange={(e) => setSite((s) => ({ ...s, [f.key]: e.target.value }))}
                                      placeholder={f.placeholder}
                                    />
                                  ) : (
                                    <span
                                      className="min-w-0 flex-1 truncate text-[12.5px] text-muted"
                                      title={value || f.placeholder}
                                    >
                                      {value || f.placeholder}
                                    </span>
                                  )}
                                  {/^https?:\/\//i.test(value) && (
                                    <span className="settings-source-actions">
                                      <button
                                        type="button"
                                        className="settings-source-link"
                                        title={`复制${f.name}`}
                                        aria-label={`复制${f.name}链接`}
                                        onClick={async () => {
                                          const copied = await copyText(value);
                                          showToast(copied ? "链接已复制" : "复制失败", copied ? undefined : "err");
                                        }}
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                                      </button>
                                      <a
                                        href={value}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="settings-source-link"
                                        title={`打开${f.name}`}
                                        aria-label={`在新窗口打开${f.name}`}
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                          <path d="M14 5h5v5" />
                                          <path d="m19 5-9 9" />
                                          <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
                                        </svg>
                                      </a>
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </SettingsSection>

                <SettingsSection id="translation" icon="plug" title="翻译服务" desc="交易广场中文翻译与大模型配置（DeepSeek / OpenAI 兼容）" titleAction={!editingSources ? <button type="button" onClick={() => setEditingSources(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-brand-hover hover:text-ink" title="编辑翻译配置" aria-label="编辑翻译配置">✎</button> : undefined} action={editingSources ? <button type="button" onClick={() => setEditingSources(false)} className="btn btn-line btn-sm">完成</button> : undefined}>
                  {(["translationProvider", "translationApiUrl", "deepseekApiUrl", "deepseekModel", "deepseekApiKey"] as const).map((key) => <div key={key} className="sw-row"><div className="sw-row-label"><b>{key === "translationProvider" ? "翻译提供商" : key === "translationApiUrl" ? "备用翻译接口" : key === "deepseekApiUrl" ? "DeepSeek API 地址" : key === "deepseekModel" ? "DeepSeek 模型" : "DeepSeek API Key"}</b></div><input className="sw-row-input" type={key === "deepseekApiKey" ? "password" : "text"} autoComplete="off" value={(site as unknown as Record<string, string>)[key] || ""} onChange={(e) => setSite((s) => ({ ...s, [key]: e.target.value }))} readOnly={!editingSources} placeholder={key === "deepseekModel" ? "deepseek-chat" : ""} /></div>)}
                </SettingsSection>

                {/* 交易：富途 OpenAPI 连接配置 + 行情源切换（两块分开，不揉在一起） */}
                <SettingsSection
                  icon="trade"
                  title="交易 · 富途 / 行情源"
                  desc="富途 OpenAPI 连接与行情源切换（自动模式失败时回退备用源）"
                  id="trade"
                  titleAction={!editingFutu ? (
                    <button type="button" onClick={() => setEditingFutu(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑富途连接" aria-label="编辑富途连接">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingFutu ? <button type="button" onClick={() => setEditingFutu(false)} className="btn btn-line btn-sm">完成</button> : undefined}
                >
                  <div className="flex flex-col">
                    <div className="flex flex-col">
                      <div className="sw-row">
                        <div className="sw-row-label"><b>OpenD 主机</b><span>本机默认 127.0.0.1；远程部署填 OpenD 所在机器地址</span></div>
                        <input className={`sw-row-input ${editingFutu ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.futuHost} readOnly={!editingFutu} onChange={(e) => setSiteField("futuHost", e.target.value)} placeholder="127.0.0.1" />
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>端口</b></div>
                        <input className={`sw-row-input ${editingFutu ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.futuPort} readOnly={!editingFutu} onChange={(e) => setSiteField("futuPort", e.target.value)} placeholder="11111" inputMode="numeric" />
                      </div>
                    </div>
                    <div className="sw-row">
                      <div className="sw-row-label"><b>连接状态</b></div>
                      <div className="ctrl">
                        <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${futuOnline === null ? "text-faint" : futuOnline ? "text-[#0fa07b]" : "text-[#e5a13b]"}`}>
                          <i className={`h-1.5 w-1.5 rounded-full ${futuOnline === null ? "bg-[#d1d5db]" : futuOnline ? "bg-[#0fa07b]" : "bg-[#e5a13b]"}`} />
                          {futuOnline === null ? "检测中…" : futuOnline ? "已连接" : "未连接"}
                        </span>
                        <button type="button" disabled={futuTest?.busy} onClick={testFutu} className="btn btn-line btn-sm disabled:opacity-60">
                          {futuTest?.busy ? "测试中…" : "测试连接"}
                        </button>
                        {futuTest?.msg && (
                          <span className={`text-[11px] ${futuTest.ok ? "text-[#0fa07b]" : "text-up"}`}>{futuTest.msg}</span>
                        )}
                      </div>
                    </div>
                    <div className="sw-row">
                      <div className="sw-row-label"><b>OpenAPI 额度</b><span>实时订阅 / 历史K线 · 已用 / 总额</span></div>
                      <div className="ctrl flex flex-nowrap items-center gap-2">
                        {futuQuota.data?.subscription && futuQuota.data.historyKl ? (
                          <span className="inline-flex min-w-0 flex-1 items-center gap-x-3 overflow-hidden text-[11.5px] text-muted">
                            <span>
                              实时订阅 <b className="text-ink">{futuQuota.data.subscription.ownUsed}</b> / {futuQuota.data.subscription.ownTotalQuota}
                            </span>
                            <span>
                              历史K线 <b className="text-ink">{futuQuota.data.historyKl.used}</b> / {futuQuota.data.historyKl.totalQuota}
                            </span>
                            {futuQuota.at && (
                              <span className="text-faint">
                                · 查询于 {new Date(futuQuota.at).toLocaleTimeString("zh-CN", { hour12: false })}
                              </span>
                            )}
                          </span>
                        ) : futuQuota.loading ? (
                          <span className="text-[11.5px] text-faint">查询中…</span>
                        ) : (
                          <span className="text-[11.5px] text-faint">未查询</span>
                        )}
                        <button type="button" disabled={futuQuota.loading} onClick={() => void loadFutuQuota()} className="btn btn-line btn-sm disabled:opacity-60">
                          {futuQuota.loading ? "查询中…" : "查询额度"}
                        </button>
                      </div>
                    </div>
                    <div className="sw-row">
                      <div className="sw-row-label"><b>行情源</b></div>
                      <div className="pills flex flex-nowrap gap-1.5">
                        {([
                          ["auto", "自动（富途优先）"],
                          ["futu", "仅富途"],
                          ["tencent", "腾讯 + Yahoo"]
                        ] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setSite((s) => ({ ...s, quoteSource: value }))}
                            className={`sw-pill ${site.quoteSource === value ? "is-active" : ""}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="sw-row">
                      <div className="sw-row-label"><span>自动模式：富途在线走富途，失败回退腾讯 + Yahoo</span></div>
                    </div>
                  </div>
                </SettingsSection>
                <SettingsSection id="currency-display" icon="stocks" title="货币金额显示" desc="控制持仓、资产分析等页面的大额金额展示方式">
                  <div className="sw-row">
                    <div className="sw-row-label">
                      <b>金额单位</b>
                      <span>小屏自动使用万、百万、千万、亿，桌面保持完整数字</span>
                    </div>
                    <div className="ctrl">
                      <select value={currencyDisplayUnit} onChange={(e) => setCurrencyDisplayUnit(e.target.value as CurrencyDisplayUnit)} className="sw-row-input" aria-label="货币金额显示单位">
                        <option value="auto">跟随设备（小屏缩写）</option>
                        <option value="compact">始终缩写</option>
                        <option value="full">始终完整</option>
                      </select>
                    </div>
                  </div>
                </SettingsSection>
              </div>
            )}

            {/* ===== 个人信息 ===== */}
            {sub === "profile" && (
              <div id="profile" className="flex flex-col gap-6">
                <SettingsHeader name="profile" title="个人信息" />
                <SettingsSection
                  icon="profile"
                  title="个人信息"
                  desc="头像、昵称与邮箱"
                  titleAction={!editingProfile ? (
                    <button type="button" onClick={() => setEditingProfile(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑个人信息" aria-label="编辑个人信息">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingProfile ? <div className="flex items-center gap-2"><button type="button" onClick={() => { setNickname(me.nickname ?? ""); setEmail(me.email ?? ""); setProfilePassword(""); setEditingProfile(false); }} className="btn btn-ghost btn-sm">取消</button><button type="button" onClick={saveProfile} className="btn btn-line btn-sm">保存资料</button></div> : undefined}
                >
                  <div className="settings-profile-grid">
                    <div className="settings-avatar-side">
                      <div className="settings-avatar-wrap">
                        {me.avatar ? <img src={me.avatar} alt={`${me.username} 头像`} /> : <span>{me.username.slice(0, 1).toUpperCase()}</span>}
                        {editingProfile && <button type="button" disabled={avatarUploading} onClick={() => avatarRef.current?.click()} aria-label="上传新头像">
                          {avatarUploading ? <svg viewBox="0 0 24 24" fill="none" className="animate-spin"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg> : <SubNavIcon name="image" className="h-3.5 w-3.5" />}
                        </button>}
                        <input ref={avatarRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.target.value = ""; }} />
                      </div>
                      <div className="settings-profile-identity">
                        <strong>{me.nickname || me.username}</strong>
                        <span>@{me.username}</span>
                        <em>{user.role === "admin" ? "管理员" : "成员"}</em>
                      </div>
                      {editingProfile && <><button type="button" disabled={avatarUploading} onClick={() => avatarRef.current?.click()} className="btn btn-ghost btn-sm">上传头像</button><small>jpg / png / webp，≤ 5MB</small></>}
                      {avatarMsg && <p className={avatarMsg.type === "ok" ? "is-ok" : "is-error"}>{avatarMsg.text}</p>}
                    </div>
                    <div className="settings-profile-fields">
                      <div className="sw-row">
                        <div className="sw-row-label"><b>用户名<span className="ml-0.5" style={{ display: "inline" }}>*</span></b><span>唯一标识，不可修改</span></div>
                        <div className="ctrl" style={{ flex: 1 }}><code className="settings-code-value">{me.username}</code></div>
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>昵称</b><span>最多 20 个字符</span></div>
                        <div className="ctrl" style={{ flex: 1 }}>
                          {editingProfile ? (
                            <input ref={nickInputRef} value={nickname} onChange={(e) => setNickname(e.target.value)} className="sw-row-input" />
                          ) : (
                            <span className="settings-profile-value" title={nickname}>{nickname || "未设置昵称"}</span>
                          )}
                        </div>
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>登录邮箱<span className="ml-0.5" style={{ display: "inline" }}>*</span></b><span>用于账号识别与通知</span></div>
                        <div className="ctrl" style={{ flex: 1 }}>
                          {editingProfile ? (
                            <input ref={emailInputRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="sw-row-input" />
                          ) : (
                            <span className="settings-profile-value" title={email}>{email || "未设置邮箱"}</span>
                          )}
                        </div>
                      </div>
                      {editingProfile && email.trim().toLowerCase() !== (me.email ?? "").trim().toLowerCase() && (
                        <div className="sw-row">
                          <div className="sw-row-label"><b>安全验证</b><span>修改登录邮箱需要当前密码</span></div>
                          <div className="ctrl" style={{ flex: 1 }}><input type="password" value={profilePassword} onChange={(e) => setProfilePassword(e.target.value)} autoComplete="current-password" placeholder="当前密码" className="sw-row-input" /></div>
                        </div>
                      )}
                      {nickMsg && <p className={`settings-form-message ${nickMsg.type === "ok" ? "is-ok" : "is-error"}`}>{nickMsg.text}</p>}
                    </div>
                  </div>
                  {editingProfile && <><div className="subhead">密码</div>
                  <form onSubmit={changePassword} className="settings-password-grid">
                    <label><span>当前密码</span><input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required /></label>
                    <label><span>新密码</span><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required placeholder="至少 8 位，含字母和数字" /></label>
                    <label><span>确认新密码</span><input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required /></label>
                    <button type="submit" disabled={pwdBusy} className="btn btn-ghost btn-sm">{pwdBusy ? "提交中…" : "修改密码"}</button>
                  </form>
                  {pwdMsg && <p className={`settings-form-message ${pwdMsg.type === "ok" ? "is-ok" : "is-error"}`}>{pwdMsg.text}</p>}</>}
                  <div className="subhead">数据与备份</div>
                  <div className="settings-profile-actions">
                  <div className="sw-row">
                    <div className="sw-row-label">
                      <span
                        ref={dataTipRef}
                        className="sw-help-tip"
                        style={{ marginLeft: 0 }}
                        onMouseEnter={() => {
                          const win = dataTipRef.current?.closest(".sv-win-root") as HTMLElement | null;
                          const r = dataTipRef.current?.getBoundingClientRect();
                          if (!r) return;
                          const wr = win?.getBoundingClientRect();
                          setDataTip({ top: (wr ? r.bottom - wr.top : r.bottom) + 8, left: wr ? r.left - wr.left : r.left });
                        }}
                        onMouseLeave={() => setDataTip(null)}
                      >
                        <b className="!text-[12.5px] underline decoration-dotted decoration-[var(--sv-text-3)] underline-offset-4">网站数据</b>
                      </span>
                    </div>
                    <div className="ctrl">
                      <button type="button" disabled={backupBusy === "export"} onClick={exportSiteBackup} className="btn btn-ghost btn-sm disabled:opacity-60">{backupBusy === "export" ? "导出中…" : "导出"}</button>
                      <button type="button" disabled={backupBusy === "import"} onClick={() => importBackupRef.current?.click()} className="btn btn-ghost btn-sm disabled:opacity-60">{backupBusy === "import" ? "导入中…" : "导入"}</button>
                      <input ref={importBackupRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importSiteBackup(f); }} />
                    </div>
                  </div>
                  {dataTip && (
                    <div className="sw-tip-fixed" style={{ top: dataTip.top, left: dataTip.left }}>
                      <span className="block"><b className="text-up">导出 / 导入：</b>你的持仓、订单、自选分组、个人偏好与昵称</span>
                      <span className="block mt-1"><b className="text-up">数据：</b>纯数据，不含图标 / 图片与数据库连接串等环境专属配置</span>
                      <span className="block mt-0.5 opacity-70"><b className="text-up">权限：</b>管理员额外包含站点设置与名人持仓</span>
                    </div>
                  )}
                  <div className="sw-row">
                    <div className="sw-row-label"><b>持仓数据</b><span>导出持仓与自选记录，共 {recordsCount} 条</span></div>
                    <button type="button" onClick={onExport} className="btn btn-ghost btn-sm">导出</button>
                  </div>
                  </div>
                  <div className="subhead settings-danger-title">危险操作</div>
                  <div className="settings-danger-zone">
                  <div className="sw-row">
                    <div className="sw-row-label"><b>清空数据</b><span>不可恢复，请谨慎操作</span></div>
                    <button type="button" onClick={clearAll} disabled={clearing || recordsCount === 0} className="btn btn-ghost btn-sm !text-up disabled:opacity-50">{clearing ? "清空中…" : "清空"}</button>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>注销账号</b><span>永久删除本账号及全部数据，不可恢复</span></div>
                    <button type="button" onClick={() => setShowDeleteConfirm(true)} className="btn btn-ghost btn-sm !text-up">注销账号</button>
                  </div>
                  </div>
                </SettingsSection>
              </div>
            )}

            {/* ===== 数据库增强 ===== */}
            {sub === "database" && isAdminUser && (
              <div id="database" className="flex flex-col gap-6">
                <SettingsHeader name="database" title="数据库增强" />

                {/* 类型选择 */}
                <SettingsSection
                  icon="database"
                  title="数据库"
                  desc="SQLite 单文件或 PostgreSQL 远程存储"
                  titleAction={!editingDb ? (
                    <button type="button" onClick={() => setEditingDb(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑数据库" aria-label="编辑数据库">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingDb ? <button type="button" onClick={() => setEditingDb(false)} className="btn btn-line btn-sm">完成</button> : undefined}
                >
                  <div className="subhead">数据库类型</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {([
                      { type: "sqlite" as const, title: "SQLite", desc: "内置文件数据库，零配置，适合个人使用" },
                      { type: "postgres" as const, title: "PostgreSQL", desc: "开源关系型数据库，适合多用户/部署环境" }
                    ]).map((opt) => (
                      <button
                        key={opt.type}
                        type="button"
                        disabled={!editingDb}
                        onClick={() => setSite({ ...site, dbType: opt.type })}
                        className={`rounded-[12px] border p-4 text-left transition-all duration-200 ${
                          site.dbType === opt.type
                            ? "border-ink/60 bg-white shadow-sm dark:border-[#5b6678] dark:bg-[#262c3a]"
                            : "border-edge hover:border-edge-strong"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-ink">{opt.title}</span>
                          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border-2 ${site.dbType === opt.type ? "border-ink/70 bg-ink dark:border-white/80 dark:bg-white" : "border-edge-strong"}`}>
                            {site.dbType === opt.type && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-white dark:text-[#1a1f2b]"><path d="m5 13 4 4L19 7" /></svg>
                            )}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted">{opt.desc}</p>
                      </button>
                    ))}
                  </div>

                {/* SQLite 信息 */}
                {site.dbType === "sqlite" && (
                  <>
                    <div className="subhead">SQLite 状态</div>
                    {dbStatus ? (
                      <div className="grid gap-3 text-sm sm:grid-cols-2">
                        <div className="settings-db-stat">
                          <span className="block text-xs text-muted">数据库文件</span>
                          <span className="block break-all font-mono text-xs text-ink-2">{dbStatus.file}</span>
                        </div>
                        <div className="settings-db-stat">
                          <span className="block text-xs text-muted">文件大小</span>
                          <span className="text-sm font-semibold tabular-nums">
                            {(dbStatus.sizeBytes / 1024).toFixed(1)} KB
                          </span>
                        </div>
                        <div className="settings-db-stat sm:col-span-2">
                          <span className="block text-xs text-muted">数据表（{dbStatus.tables.length} 张）</span>
                          <span className="text-sm text-ink-2">{dbStatus.tables.join("、")}</span>
                        </div>
                      </div>
                    ) : dbStatusError ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300">
                        <span>{dbStatusError}</span>
                        <button type="button" onClick={() => setDbStatusRetry((value) => value + 1)} className="rounded-lg border border-current/25 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-red-100 dark:hover:bg-red-500/15">重试</button>
                      </div>
                    ) : dbStatusLoading ? (
                      <div className="settings-inline-state" role="status" aria-live="polite">
                        <span className="settings-state-dot" aria-hidden="true" />
                        <span>正在读取数据库状态</span>
                      </div>
                    ) : (
                      <p className="text-sm text-faint">暂无数据库状态</p>
                    )}
                  </>
                )}

                {/* PostgreSQL 连接配置 */}
                {site.dbType === "postgres" && (
                  <>
                    <div className="subhead">PostgreSQL 连接配置</div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                        主机地址
                        <input value={site.pgHost} readOnly={!editingDb} onChange={(e) => setSite({ ...site, pgHost: e.target.value })} placeholder="如：localhost 或 db.example.com" className={`h-[42px] rounded-[10px] border border-edge-strong px-3 outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] ${editingDb ? "" : "!border-transparent !bg-transparent !shadow-none"}`} />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                        端口
                        <input value={site.pgPort} readOnly={!editingDb} onChange={(e) => setSite({ ...site, pgPort: e.target.value })} placeholder="5432" className={`h-[42px] rounded-[10px] border border-edge-strong px-3 outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] ${editingDb ? "" : "!border-transparent !bg-transparent !shadow-none"}`} />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                        数据库名
                        <input value={site.pgDatabase} readOnly={!editingDb} onChange={(e) => setSite({ ...site, pgDatabase: e.target.value })} placeholder="如：fire" className={`h-[42px] rounded-[10px] border border-edge-strong px-3 outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] ${editingDb ? "" : "!border-transparent !bg-transparent !shadow-none"}`} />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2">
                        用户名
                        <input value={site.pgUser} readOnly={!editingDb} onChange={(e) => setSite({ ...site, pgUser: e.target.value })} placeholder="如：postgres" className={`h-[42px] rounded-[10px] border border-edge-strong px-3 outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] ${editingDb ? "" : "!border-transparent !bg-transparent !shadow-none"}`} />
                      </label>
                      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2 md:col-span-2">
                        密码
                        <input type="password" value={site.pgPassword} readOnly={!editingDb} onChange={(e) => setSite({ ...site, pgPassword: e.target.value })} placeholder="数据库密码" className={`h-[42px] rounded-[10px] border border-edge-strong px-3 outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] ${editingDb ? "" : "!border-transparent !bg-transparent !shadow-none"}`} />
                      </label>
                    </div>
                    {dbMsg && (
                      <p className={`rounded-[10px] px-3.5 py-2.5 text-[13px] break-all ${dbMsg.type === "ok" ? "bg-bg-gray text-ink" : "bg-up-bg text-up"}`}>
                        {dbMsg.text}
                      </p>
                    )}
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button type="button" disabled={dbTesting || !editingDb} onClick={testDb} className="btn btn-ghost btn-sm disabled:opacity-60">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" />
                        </svg>
                        {dbTesting ? "测试中…" : "测试连接"}
                      </button>
                      <button type="button" disabled={dbSaving || !editingDb} onClick={saveDb} className="btn btn-line btn-sm disabled:opacity-60">
                        {dbSaving ? "保存中…" : "保存数据库配置"}
                      </button>
                    </div>
                  </>
                )}
                </SettingsSection>
              </div>
            )}

            {/* ===== 定时任务 ===== */}
            {sub === "cron" && isAdminUser && (
              <div id="cron" className="flex flex-col gap-6">
                <SettingsHeader name="cron" title="定时任务" />
                <SettingsSection icon="cron" title="定时任务" desc="自动刷新汇率、行情与数据缓存">
                <div className="settings-task-list">
                  {[
                    {
                      key: "rates",
                      icon: "money",
                      name: "汇率定时刷新",
                      desc: "从汇率接口拉取 USD 兑各币种汇率，供账户资产总资产换算",
                      schedule: "每天 09:00 / 23:00",
                      state: "已启用",
                      action: true
                    },
                    {
                      key: "earnings",
                      icon: "cal",
                      name: "财报日历缓存",
                      desc: "缓存美股 / A股财报数据，减少外部接口请求",
                      schedule: "请求后缓存 30 分钟",
                      state: "已启用"
                    },
                    {
                      key: "topstocks",
                      icon: "chart",
                      name: "全球市值榜缓存",
                      desc: "缓存全球资产市值排行（日股 / 韩股 / 全球 6 小时，其余 30 分钟）",
                      schedule: "30 分钟 / 6 小时",
                      state: "已启用"
                    },
                    {
                      key: "kline",
                      icon: "wave",
                      name: "K线数据缓存",
                      desc: "缓存月 K 走势数据，避免重复抓取",
                      schedule: "10 分钟",
                      state: "已启用"
                    },
                    {
                      key: "quotes",
                      icon: "search",
                      name: "行情自动轮询",
                      desc: "后端页面每 60 秒自动刷新一次实时行情",
                      schedule: "每 60 秒",
                      state: "已启用"
                    },
                    {
                      key: "board",
                      icon: "plug",
                      name: "行情板刷新间隔",
                      desc: "我的行情板按配置的间隔刷新（可自定义）",
                      schedule: "1 秒 - 1 日 可调",
                      state: "可配置"
                    }
                  ].map((task) => (
                    <div key={task.key} className="settings-task-row">
                      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-edge text-muted">
                        <SubNavIcon name={task.icon} className="h-[18px] w-[18px]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-ink">{task.name}</span>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-brand-deep ring-1 ring-brand/20 dark:bg-white/10">
                            {task.state}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted">{task.desc}</p>
                      </div>
                      <span className="flex-none rounded-full border border-edge bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2 dark:bg-white/5">
                        {task.schedule}
                      </span>
                      {task.action && <CronRefreshButton />}
                    </div>
                  ))}
                  <BackupTaskCard />
                </div>
                </SettingsSection>
              </div>
            )}

            {/* ===== API 开发接口 ===== */}
            {sub === "api" && (
              <div id="api" className="flex flex-col gap-6">
                <SettingsHeader name="api" title="API 接口" />
                <SettingsSection
                  icon="api"
                  title="API 开发接口"
                  desc="接口鉴权、版本与访问策略"
                  action={
                    <a href="/api-docs" target="_blank" rel="noreferrer" className="btn btn-line btn-sm">
                      打开完整文档
                    </a>
                  }
                >
                  <div className="sw-row">
                    <div className="sw-row-label"><b>鉴权方式</b><span>登录态与程序化访问</span></div>
                    <div className="ctrl"><span className="sw-pill is-active">Session Cookie</span><span className="sw-pill">Bearer Token</span></div>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>接口版本</b><span>稳定版基础路径</span></div>
                    <code className="settings-code-value">/api/v1</code>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>访问保护</b><span>限制异常频率并保留错误语义</span></div>
                    <span className="settings-status-badge is-on"><i />已启用</span>
                  </div>
                </SettingsSection>
              </div>
            )}

            {/* ===== 关于 ===== */}
            {sub === "about" && (
              <div id="about" className="flex flex-col gap-6">
                <SettingsHeader name="info" title="关于" />
                <SettingsSection icon="info" title="关于" desc="版本、技术栈与外部数据源">
                  <div className="sw-row">
                    <div className="sw-row-label"><b>当前版本</b><span>Fire Web 稳定版本</span></div>
                    <button type="button" onClick={() => setVersionOpen(true)} className="settings-link-value">
                      Fire {CURRENT_VERSION.version}<span>{CURRENT_VERSION.changes.length} 项更新</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                    </button>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>前端技术栈</b><span>交互与响应式界面</span></div>
                    <span className="settings-detail-value">Next.js 15 · React 19 · TypeScript · Tailwind CSS</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>数据与服务</b><span>本地优先，可切换企业数据库</span></div>
                    <span className="settings-detail-value">Node.js · SQLite · PostgreSQL</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>部署运行</b><span>容器镜像与受限更新</span></div>
                    <span className="settings-detail-value">Docker · GHCR · Watchtower</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>外部数据源</b><span>行情、财报、汇率与公开披露</span></div>
                    <span className="settings-detail-value">腾讯行情 · 东方财富 · SEC EDGAR · CompaniesMarketCap</span>
                  </div>
                </SettingsSection>
              </div>
            )}
          </div>
        </div>
      </div>
      {versionOpen && <VersionModal onClose={() => setVersionOpen(false)} />}
    </div>
  );
}
