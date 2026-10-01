"use client";

import { useWorkspaceSearchParams as useSearchParams, useWorkspaceLocationGuard } from "@/lib/workspacePanel";

import PasswordInput from "@/components/PasswordInput";
import PasskeySettings from "@/components/PasskeySettings";
import { createPasskeySettingsData } from "@/lib/passkeySettingsData";
import SecurityCheck from "@/components/SecurityCheck";
import SettingsManagedGroup, { SettingsManagedPane } from "@/components/SettingsManagedGroup";
import AppModal from "@/components/AppModal";
import AppAuthorizationSettings from "@/components/AppAuthorizationSettings";
import EmailRecoveryForm from "@/components/EmailRecoveryForm";
import PasswordStrength from "@/components/PasswordStrength";
import { resolveSettingsLocation } from "@/lib/settingsNavigation";
import { readLimitedResponseJson } from "@/lib/requestBody";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isSixDigitTotp, normalizeTotpDigits } from "@/lib/totpInput";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import type { GroupConfig, ModelServiceConfig, SiteSettings, TabConfig, TickerConfig } from "@/lib/types";
import { showToast } from "@/lib/toast";
import { appConfirm, appPrompt } from "@/lib/appDialog";
import AppSelect from "@/components/AppSelect";
import { copyText } from "@/lib/clipboard";
import PaletteSettings from "@/components/PaletteSettings";
import { SettingsSection, SettingsSectionSelection, SubNavIcon } from "@/components/SettingsHeader";
import { LOGO_FONT_LABELS, logoFontClass } from "@/lib/logoFont";
import MarketIcon from "@/components/MarketIcon";
import DeleteIcon from "@/components/DeleteIcon";
import { CURRENT_VERSION } from "@/lib/versions";
import { useAssetIcons } from "@/lib/useAssetIcons";
import { NAV_ICONS } from "@/lib/navIcons";
import SafeAssetImage from "@/components/SafeAssetImage";
import MobileNavigationSettings from "@/components/MobileNavigationSettings";
import type { BackupConfig } from "@/lib/backup";
import { DEFAULT_HOLDING_COLUMNS } from "@/lib/holdingColumns";
import { useCurrencyDisplayUnit, type CurrencyDisplayUnit } from "@/lib/currencyPrefs";
import { applyMarketBadges, DEFAULT_MARKET_BADGES, MARKET_BADGE_ITEMS, normalizeMarketBadges } from "@/lib/marketBadge";

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
  user: { username: string; nickname?: string; uid?: string; email?: string; emailVerified?: boolean; avatar?: string; role?: string };
  recordsCount: number;
  onExport: () => void;
  onClearAll: (password: string) => Promise<boolean>;
  onTabsChange: (tabs: TabConfig[]) => void;
  initialSub?: string;
  initialPasskeys?: import("@/lib/passkeySettingsData").PasskeySettingsSnapshot | null;
  /** 服务端首帧设置快照，避免刷新时先渲染默认开关再回落到真实值 */
  initialSettings?: Pick<SiteSettings, "allowRegister" | "stockIconCdn" | "marketBadges" | "marketBadgesVisible" | "translationEnabled" | "tabs" | "mobileNavigationOrder" | "groups" | "markets" | "marketLabels" | "modelServices" | "title" | "logoText" | "siteLogo" | "ico" | "pwaIcon" | "appDisplayName" | "appDisplayIcon">;
}

function SettingsDetailShell({ title, category, detailKey, showBack = false, closeDisabled = false, editable = false, editing = false, onBack, onEdit, onSave, onCancel, onClose, children }: { title: string; category: string; detailKey?: string; showBack?: boolean; closeDisabled?: boolean; editable?: boolean; editing?: boolean; onBack?: () => void; onEdit?: () => void; onSave?: () => void; onCancel?: () => void; onClose: () => void; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  closeDisabledRef.current = closeDisabled;
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => {
    if (closingRef.current || closeDisabledRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    closeTimer.current = setTimeout(() => onCloseRef.current(), reducedMotion ? 0 : 180);
  }, []);
  useLayoutEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 详情上方还有确认、找回密码或版本弹窗时，只允许最上层弹窗处理 Esc。
      if (document.querySelector("[data-priority-modal='true']")) return;
      requestClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKeyDown);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [mounted, requestClose]);
  const content = (
    <div className={`sc-detail-layer fixed inset-0 z-[10900] flex items-center justify-center p-4 sm:p-8${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="关闭设置详情" className="sc-detail-scrim absolute inset-0" onClick={requestClose} disabled={closing || closeDisabled} />
      <section className="sc-detail-dialog relative flex w-full max-w-[600px] flex-col overflow-hidden" data-detail={detailKey}>
        <div className="sc-detail-theme-bridge sv-win-root sv-orca sv-center flex min-h-0 flex-1 flex-col">
        <header className="sc-detail-dialog-head flex-none">
          {showBack && <button type="button" className="sc-detail-back" aria-label="返回" onClick={onBack || requestClose} disabled={closing || closeDisabled}><span aria-hidden="true">‹</span></button>}
          <div className="min-w-0"><span>{category}</span><h2>{title}</h2></div>
          <div className="sc-detail-dialog-actions">
            {editable && (editing ? <><button type="button" disabled={closeDisabled} className="sc-detail-text-action" onClick={onCancel}>取消</button><button type="button" disabled={closeDisabled} className="sc-detail-primary-action" onClick={onSave}>{closeDisabled ? "保存中…" : "保存"}</button></> : <button type="button" className="sc-detail-text-action" onClick={onEdit}>编辑</button>)}
            <button type="button" className="sc-detail-close" aria-label="关闭" onClick={requestClose} disabled={closing || closeDisabled}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
          </div>
        </header>
        <div className="sc-detail-dialog-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      </section>
    </div>
  );
  return mounted ? createPortal(content, document.body) : content;
}

const SETTINGS_SUB_KEYS = ["site", "palette", "features", "stocks", "api", "profile", "totp", "passkeys", "authorizations", "database", "cron", "about"] as const;
type SubKey = (typeof SETTINGS_SUB_KEYS)[number];
function isSettingsSub(value: string | undefined | null): value is SubKey {
  return Boolean(value && (SETTINGS_SUB_KEYS as readonly string[]).includes(value));
}

// 仅管理员可见的设置子项
const ADMIN_SUB_KEYS = new Set<SubKey>(["site", "features", "stocks", "database", "cron"]);

/** ⌘K 命令搜索索引：关键词 → 子分类 + 锚点 */
type SettingsSearchItem = { sub: SubKey; anchor: string; label: string; groupLabel: string; keywords: string; adminOnly?: boolean };
const SETTINGS_SEARCH_INDEX: SettingsSearchItem[] = [
  { sub: "palette", anchor: "palette", label: "外观", groupLabel: "配色", keywords: "字体 字重 加粗 苹果 SF Pro Diatype Arial 配色 主题 颜色 模式 浅色 深色 跟随系统 Meta Liquid Glass 玻璃 海盐 松林 琥珀 暮光" },
  { sub: "site", anchor: "info", label: "站点信息", groupLabel: "网站", keywords: "网站 标题 域名 注册 页脚 简介" },
  { sub: "site", anchor: "appearance", label: "网站形象", groupLabel: "网站", keywords: "图标 logo 字体 背景 形象 favicon 图片" },
  { sub: "site", anchor: "ticker", label: "首页指数", groupLabel: "网站", keywords: "指数 轮换 首页 ticker 行情条" },
  { sub: "site", anchor: "nav", label: "首页导航", groupLabel: "网站", keywords: "导航 菜单 首页 入口" },
  { sub: "site", anchor: "app-nav", label: "应用导航", groupLabel: "网站", keywords: "后台 侧栏 移动端 默认页 图标 顺序" },
  { sub: "site", anchor: "mobile-nav", label: "手机导航", groupLabel: "网站", keywords: "手机 底部 胶囊 更多 导航 顺序 排序" },
  { sub: "features", anchor: "trading-square", label: "公开动态来源", groupLabel: "功能", keywords: "交易广场 特朗普 段永平 更新 刷新 频率 缓存" },
  { sub: "stocks", anchor: "groups", label: "券商分组", groupLabel: "股票", keywords: "券商 分组 别名 持仓" },
  { sub: "stocks", anchor: "market-badges", label: "市场色块", groupLabel: "股票", keywords: "市场 色块 徽标 颜色 显示 US HK A股 上证 深证 加密" },
  { sub: "stocks", anchor: "translation", label: "模型服务", groupLabel: "智能服务", keywords: "模型服务 AI 大模型 账户助手 翻译 DeepSeek OpenAI API" },
  { sub: "stocks", anchor: "trade", label: "交易 · 富途", groupLabel: "股票", keywords: "富途 futu opend 交易 行情源 主机 端口 腾讯 yahoo 备用" },
  { sub: "stocks", anchor: "currency-display", label: "货币金额显示", groupLabel: "股票", keywords: "货币 单位 金额 万 百万 千万 亿 缩写" },
  { sub: "stocks", anchor: "sources", label: "行情与汇率接口", groupLabel: "股票", keywords: "股票来源 接口 行情 搜索 分时 汇率 url 数据源" },
  { sub: "stocks", anchor: "source-reports", label: "财报接口", groupLabel: "股票", keywords: "美股 A股 港股 财报 日历 接口 数据源" },
  { sub: "stocks", anchor: "source-icons", label: "公司图标接口", groupLabel: "股票", keywords: "美股 A股 公司 图标 logo 接口 数据源" },
  { sub: "stocks", anchor: "source-content", label: "公开内容接口", groupLabel: "股票", keywords: "交易广场 特朗普 动态 翻译 接口 数据源" },
  { sub: "profile", anchor: "profile", label: "个人信息", groupLabel: "账号", keywords: "头像 昵称 邮箱" },
  { sub: "profile", anchor: "password", label: "更改密码", groupLabel: "账号", keywords: "密码 登录 安全" },
  { sub: "profile", anchor: "data", label: "导入与导出", groupLabel: "数据", keywords: "备份 持仓 导出 导入 数据" },
  { sub: "profile", anchor: "danger", label: "清空投资数据", groupLabel: "数据", keywords: "清空 删除 持仓 自选 订单 投资 数据" },
  { sub: "profile", anchor: "delete-account", label: "注销账号", groupLabel: "数据", keywords: "注销 永久删除 账号 数据" },
  { sub: "totp", anchor: "totp", label: "双重验证", groupLabel: "账号", keywords: "2FA 二次验证 TOTP 验证器 备用码 谷歌验证 Google Authenticator 安全" },
  { sub: "passkeys", anchor: "passkeys", label: "通行密钥", groupLabel: "账号", keywords: "Passkey WebAuthn iCloud Bitwarden 1Password Face ID Touch ID 无密码 登录 安全 通行密匙" },
  { sub: "authorizations", anchor: "authorizations", label: "应用授权", groupLabel: "账号", keywords: "Alcor Api App iOS iPhone 网页授权 连接 地址 公网 配置 测试 调试 名称 图标 设备 权限 撤销 断开" },
  { sub: "passkeys", anchor: "passkey-config", label: "通行密钥域名", groupLabel: "账号", keywords: "Passkey WebAuthn HTTPS 域名 站点名称 登录配置", adminOnly: true },
  { sub: "database", anchor: "database", label: "数据库", groupLabel: "系统", keywords: "数据库 sqlite postgres 连接 存储" },
  { sub: "cron", anchor: "cron", label: "定时任务", groupLabel: "系统", keywords: "定时 汇率 缓存 自动更新 财报" },
  { sub: "cron", anchor: "mail", label: "邮件服务", groupLabel: "系统", keywords: "SMTP 邮件 密码 找回 重置 邮箱" },
  { sub: "cron", anchor: "backups", label: "自动备份", groupLabel: "系统", keywords: "数据库 定时 备份 保留 立即备份" },
  { sub: "api", anchor: "api", label: "API 接口", groupLabel: "系统", keywords: "api 接口 开发 文档 鉴权" },
  { sub: "about", anchor: "about", label: "关于", groupLabel: "系统", keywords: "关于 版本 技术栈 数据源 更新" }
];

function defaultAnchorFor(sub: SubKey): string {
  return SETTINGS_SEARCH_INDEX.find((item) => item.sub === sub)?.anchor || "info";
}

const SETTINGS_CATEGORIES = [
  { key: "account", label: "账号与安全", icon: "account", desc: "管理个人资料、密码和登录方式。", anchors: ["profile", "password", "totp", "passkeys", "authorizations", "passkey-config"] },
  { key: "website", label: "外观与网站", icon: "website", desc: "设置网站形象、配色与首页内容。", anchors: ["palette", "info", "appearance", "ticker", "nav", "app-nav", "mobile-nav"] },
  { key: "investing", label: "投资与行情", icon: "stocks", desc: "管理券商、行情来源与金额显示。", anchors: ["groups", "market-badges", "currency-display", "trade", "sources", "source-reports", "source-icons", "source-content"] },
  { key: "services", label: "功能与模型", icon: "model", desc: "配置模型服务与内容更新。", anchors: ["translation", "trading-square"] },
  { key: "system", label: "数据与系统", icon: "data", desc: "备份个人数据，管理存储与定时任务。", anchors: ["data", "database", "cron", "mail", "backups", "danger", "delete-account"] },
  { key: "developer", label: "开发与关于", icon: "api", desc: "查看接口文档、版本与技术信息。", anchors: ["api", "about"] }
];
const SETTINGS_ANCHORS = SETTINGS_SEARCH_INDEX.map((item) => item.anchor);
const SOURCE_DETAIL_ANCHORS = new Set(["sources", "source-reports", "source-icons", "source-content"]);
const EDITABLE_DETAIL_ANCHORS = new Set(["appearance", "ticker", "nav", "app-nav", "groups", "market-badges", ...SOURCE_DETAIL_ANCHORS, "translation", "trade", "profile", "database", "trading-square"]);

function persistSettingsAnchor(sub: SubKey, anchor: string): boolean {
  const anchors = SETTINGS_SEARCH_INDEX.filter((item) => item.sub === sub);
  return anchors.length > 1 && anchor !== anchors[0].anchor;
}

const SETTINGS_ANCHOR_ICONS: Record<string, string> = {
  info: "site",
  appearance: "image",
  ticker: "stocks",
  nav: "home",
  "app-nav": "app-nav",
  "mobile-nav": "mobile-nav",
  "trading-square": "features",
  groups: "tag",
  "market-badges": "badges",
  translation: "model",
  sources: "plug",
  "source-reports": "source-reports",
  "source-icons": "source-icons",
  "source-content": "source-content",
  trade: "trade",
  "currency-display": "currency",
  password: "password",
  data: "data",
  danger: "danger",
  "delete-account": "delete-account",
  profile: "profile",
  totp: "totp",
  passkeys: "passkeys",
  authorizations: "authorizations",
  "passkey-config": "passkey-config",
  database: "database",
  cron: "cron",
  mail: "api",
  backups: "backups",
  api: "api",
  about: "about"
};

/** 网站形象素材：只读时保持 Meta 式摘要行，进入编辑后再显示上传、移除与链接输入。 */
function BrandAssetRow({
  label,
  desc,
  value,
  fallbackValue = "",
  emptyLabel = "未设置",
  customLabel = "已自定义",
  onChange,
  inputRef,
  accept,
  onUpload,
  onClear,
  kind,
  editable = true,
  busy = false,
  clearLabel = "移除"
}: {
  label: string;
  desc: string;
  value: string;
  fallbackValue?: string;
  emptyLabel?: string;
  customLabel?: string;
  onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  accept: string;
  onUpload: (f: File) => void;
  onClear: () => void;
  kind: "icon" | "logo" | "wide";
  editable?: boolean;
  busy?: boolean;
  clearLabel?: string;
}) {
  const previewValue = value || fallbackValue;
  const isUrl = /^(https?:\/\/|\/)/.test(value.trim());
  return (
    <div className="brand-asset-row" data-kind={kind}>
      <button type="button" className="brand-asset-preview" onClick={() => editable && inputRef.current?.click()} disabled={!editable || busy} aria-label={`${value ? "更换" : "上传"}${label}`}>
        {previewValue ? <img src={previewValue} alt="" /> : <svg viewBox="0 0 48 36" fill="none" aria-hidden="true"><path d="M5 5h38v26H5z"/><path d="m8 27 10-10 7 7 5-5 10 8"/><circle cx="33" cy="12" r="3"/></svg>}
      </button>
      <div className="brand-asset-copy"><b>{label}</b><small>{desc}</small><em className={value ? "is-custom" : ""}>{value ? customLabel : emptyLabel}</em></div>
      {editable && <div className="brand-asset-actions">
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? "上传中…" : value ? "更换" : "上传"}</button>
        {value && <button type="button" onClick={onClear} disabled={busy}>{clearLabel}</button>}
      </div>}
      {editable && <div className="brand-asset-link">
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="粘贴图片链接" inputMode="url" aria-label={`${label}链接`} />
        {isUrl && <a href={value} target="_blank" rel="noreferrer" aria-label={`在新窗口打开${label}`} title="打开原图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M14 5h5v5"/><path d="m19 5-9 9"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></a>}
      </div>}
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
    </div>
  );
}


const SUB_GROUPS: { label: string; items: { key: SubKey; label: string; desc: string }[] }[] = [
  { label: "外观", items: [{ key: "palette", label: "外观", desc: "模式与主题颜色" }] },
  {
    label: "站点",
    items: [
      { key: "site", label: "网站设置", desc: "站点信息与首页文案、导航" }
    ]
  },
  {
    label: "功能",
    items: [{ key: "features", label: "功能", desc: "业务功能与更新策略" }]
  },
  {
    label: "股票",
    items: [{ key: "stocks", label: "股票设置", desc: "券商管理、市场色块与数据来源接口" }]
  },
  {
    label: "账号",
    items: [
      { key: "profile", label: "个人信息", desc: "头像、资料、密码、数据管理" },
      { key: "totp", label: "2FA", desc: "验证器与备用码" },
      { key: "passkeys", label: "通行密钥", desc: "设备验证与密码管理器" },
      { key: "authorizations", label: "管理授权", desc: "App 连接与访问权限" }
    ]
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

function SettingsSwitch({ checked, onChange, label = "切换设置" }: { checked: boolean; onChange: () => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-6 w-11 flex-none rounded-full transition-colors duration-200 ${checked ? "bg-[#34c759]" : "bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full shadow-sm transition-transform duration-200 ${checked ? "translate-x-5" : ""}`}
        style={{ backgroundColor: "#ffffff" }}
      />
    </button>
  );
}

const DEFAULT_TABS: TabConfig[] = [
  { key: "watchlist", label: "自选股", url: "/watchlist" },
  { key: "holdings", label: "账户资产", url: "/holdings", default: true },
  { key: "global", label: "全球预览", url: "/global" },
  { key: "earnings", label: "财报日历", url: "/earnings" },
  { key: "assistant", label: "智能助手", url: "/assistant" },
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
  // 备份配置独立于站点设置，首帧不能猜测开关状态；保持控件占位但不可见，待服务端快照到位后一次性显示。
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [intervalHours, setIntervalHours] = useState(24);
  const [keep, setKeep] = useState(7);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");

  async function refresh() {
    setLoadError("");
    try {
      const res = await fetch("/api/backup", { cache:"no-store", signal:AbortSignal.timeout(15000) });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.config) throw new Error(data?.error || "无法读取备份设置");
      if (data?.config) {
        setCfg(data.config);
        setEnabled(data.config.enabled);
        setIntervalHours(data.config.intervalHours);
        setKeep(data.config.keep);
      }
      if (Array.isArray(data?.backups)) setBackups(data.backups);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "无法读取备份设置");
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
    n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
  if (!cfg) return <div className="settings-load-state" role="status">{loadError || "正在读取备份设置…"}{loadError && <button type="button" className="btn btn-line" onClick={() => void refresh()}>重试</button>}</div>;
  return <div className="settings-backup-panel">
    <SettingsManagedGroup scope="backups" inline>
    <SettingsManagedPane name="plan" title="备份计划" summary={`${cfg.enabled ? "已开启" : "未开启"} · ${({1:"每小时",24:"每天",168:"每周",720:"每月"} as Record<number,string>)[cfg.intervalHours] || `每 ${cfg.intervalHours} 小时`} · 保留 ${cfg.keep} 份`}>
    <fieldset className="settings-clean-group" disabled={saving || busy} aria-label="备份计划">
      <div className="sw-row"><div className="sw-row-label"><b>自动备份</b><span>保存数据库与素材文件</span></div><SettingsSwitch checked={enabled === true} onChange={() => setEnabled(v => !v)} label="自动备份" /></div>
      <div className="sw-row"><div className="sw-row-label"><b>备份频率</b></div><AppSelect value={intervalHours} onChange={value => setIntervalHours(Number(value))} options={[{ value: "1", label: "每小时" }, { value: "24", label: "每天" }, { value: "168", label: "每周" }, { value: "720", label: "每月" }]} className="settings-clean-select" ariaLabel="备份频率" /></div>
      <div className="sw-row"><div className="sw-row-label"><b>保留份数</b><span>自动清理较早的备份</span></div><AppSelect value={keep} onChange={value => setKeep(Number(value))} options={[3, 7, 14, 30].map(value => ({ value:String(value), label:`${value} 份` }))} className="settings-clean-select" ariaLabel="备份保留份数" /></div>
    </fieldset>
    <button type="button" className="btn settings-full-action" onClick={save} disabled={saving || busy || (cfg.enabled === enabled && cfg.intervalHours === intervalHours && cfg.keep === keep)}>{saving ? "保存中…" : "保存设置"}</button>
    </SettingsManagedPane>
    <SettingsManagedPane name="records" title="备份记录" summary={`${backups.length} 份 · ${fmtSize(totalSize)}`}>
    <div className="settings-clean-group">
      <div className="sw-row"><div className="sw-row-label"><b>最近备份</b><span>{last}</span></div><button type="button" className="btn btn-line" onClick={backupNow} disabled={busy || saving}>{busy ? "备份中…" : "立即备份"}</button></div>
      <div className="sw-row"><div className="sw-row-label"><b>已保存</b><span>data/backups</span></div><span className="settings-detail-value">{backups.length} 份 · {fmtSize(totalSize)}</span></div>
    </div>
    </SettingsManagedPane>
    </SettingsManagedGroup>
    {loadError && <p className="settings-inline-error" role="alert">{loadError}</p>}
  </div>;
}

const TAB_HINTS: Record<string, string> = {
  holdings: "账户资产",
  watchlist: "自选股",
  global: "全球预览",
  earnings: "财报日历",
  assistant: "智能助手",
  users: "用户管理",
  library: "素材库",
  activities: "日志",
  settings: "设置"
};

const DEFAULT_SETTINGS: SiteSettings = {
  domain: "",
  title: "",
  ico: "",
  pwaIcon: "",
  homepageBg: "",
  loginSideImage: "",
  tabs: DEFAULT_TABS,
  mobileNavigationOrder: [],
  groups: [],
  homeNav: [],
  markets: [],
  marketLabels: [],
  marketBadges: { ...DEFAULT_MARKET_BADGES },
  marketBadgesVisible: true,
  assetMarketOrder: [],
  assetAnalysisOrder: { left: [], right: [] },
  indicesOrder: [],
  allowRegister: true,
  stockIconCdn: false,
  siteLogo: "",
  appDisplayName: "",
  appDisplayIcon: "",
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
  currencyRefreshPattern: "09:00|23:00",
  earningsApiUrl: "",
  cnEarningsApiUrl: "",
  hkEarningsApiUrl: "",
  usLogoApiUrl: "",
  cnLogoApiUrl: "",
  trumpArchiveApiUrl: "",
  translationApiUrl: "",
  translationProvider: "mymemory",
  deepseekApiUrl: "",
  deepseekModel: "deepseek-chat",
  deepseekApiKey: "",
  llmProvider: "deepseek",
  llmApiUrl: "https://api.deepseek.com/chat/completions",
  llmModel: "deepseek-chat",
  llmApiKey: "",
  modelServices: [],
  tradingSquareTrumpRefreshMinutes: 5,
  tradingSquareDuanRefreshMinutes: 5,
  xueqiuCookie: "",
  translationEnabled: true,
  dbType: "sqlite",
  pgHost: "",
  pgPort: "5432",
  pgDatabase: "",
  pgUser: "",
  pgPassword: "",
  smtpHost: "",
  smtpPort: "587",
  smtpSecure: false,
  smtpUser: "",
  smtpPassword: "",
  smtpFromName: "Alcor",
  smtpFromEmail: "",
  emailLinkOrigin: "",
  holdingColumns: DEFAULT_HOLDING_COLUMNS,
  ticker: DEFAULT_TICKER
};

type ModelProviderId = "deepseek" | "openai" | "jev" | "custom";
const MODEL_PROVIDERS: Array<{ id: ModelProviderId; name: string; hint: string; color: string; url: string }> = [
  { id: "deepseek", name: "DeepSeek", hint: "官方 API", color: "#4d6bfe", url: "https://api.deepseek.com/chat/completions" },
  { id: "openai", name: "OpenAI", hint: "官方 API", color: "#10a37f", url: "https://api.openai.com/v1/chat/completions" },
  { id: "jev", name: "Jev", hint: "结构化决策", color: "#7c3aed", url: "https://api.typesafe.ai/v1/systemone" },
  { id: "custom", name: "自定义服务", hint: "OpenAI 兼容", color: "#64748b", url: "" }
];

function normalizedModelProvider(value: string): ModelProviderId {
  const provider = String(value || "").toLowerCase();
  if (provider.includes("deepseek")) return "deepseek";
  if (provider === "openai") return "openai";
  if (provider === "jev") return "jev";
  return "custom";
}

function ModelProviderIcon({ provider, icon, className = "h-10 w-10" }: { provider: ModelProviderId; icon?: string; className?: string }) {
  const meta = MODEL_PROVIDERS.find((item) => item.id === provider) || MODEL_PROVIDERS[3];
  return (
    <span className={`model-provider-icon ${className}`} style={{ "--model-color": meta.color } as React.CSSProperties} aria-hidden="true">
      {icon ? <SafeAssetImage src={icon} alt="" className="h-full w-full object-contain" style={{ width: "100%", height: "100%" }} fallback={null} /> : provider === "deepseek" ? (
        <svg viewBox="0 0 32 32"><path d="M5.2 17.2c3.7-1 5.4-3.8 5.8-8.1 2 3 4.8 4.7 8.7 4.9 2.4.1 4.5-.5 6.2-1.7-.6 5.9-4.9 10.7-11.1 11.4-4.5.5-8.1-1.4-9.6-6.5Z"/><path d="M20.2 10.6c1.8-2.2 4.3-2.8 7.1-1.7-1.2 2.7-3.5 4-6.9 3.7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
      ) : provider === "openai" ? (
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 5.2a6 6 0 0 1 10.2 4.3 6 6 0 0 1-.8 10.4A6 6 0 0 1 16 25.6a6 6 0 0 1-10.2-4.3 6 6 0 0 1 .8-10.4A6 6 0 0 1 16 5.2Z"/><path d="m10.7 9.2 10.6 6.1v7.1M21.4 9.4l-10.7 6.2v7M5.9 16h12.2"/></svg>
      ) : provider === "jev" ? (
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7h14v11a7 7 0 0 1-14 0"/><path d="M14 12h9M9 18h7"/></svg>
      ) : (
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="16" cy="16" r="12.5" strokeDasharray="3 3"/><path d="M16 10v12M10 16h12"/></svg>
      )}
    </span>
  );
}

interface DbStatus {
  type: string;
  file: string;
  sizeBytes: number;
  tables: string[];
  configuredType: string;
}

// 股票来源接口的卡片元数据（顺序即展示顺序）
const SOURCE_FIELDS: {
  key: "quoteApiUrl" | "searchApiUrl" | "chartApiUrl" | "currencyApiUrl" | "earningsApiUrl" | "cnEarningsApiUrl" | "hkEarningsApiUrl" | "usLogoApiUrl" | "cnLogoApiUrl" | "trumpArchiveApiUrl" | "translationApiUrl" | "deepseekApiUrl" | "deepseekModel" | "deepseekApiKey" | "translationProvider";
  name: string;
  desc: string;
  placeholder: string;
  icon: "chart" | "search" | "wave" | "money" | "cal" | "cn" | "hk" | "us" | "logo" | "trump" | "translate";
}[] = [
  { key: "quoteApiUrl", name: "实时行情", desc: "直接拼接股票代码，多个用逗号分隔", placeholder: "https://qt.gtimg.cn/q=", icon: "chart" },
  { key: "searchApiUrl", name: "搜索联想", desc: "用 {q} 代替查询词", placeholder: "https://smartbox.gtimg.cn/s3/?v=2&q={q}&t=all", icon: "search" },
  { key: "chartApiUrl", name: "分时走势", desc: "用 {code} 代替股票代码", placeholder: "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}", icon: "wave" },
  { key: "currencyApiUrl", name: "汇率接口", desc: "只走此地址；没返回的币种在换算页显示暂无汇率", placeholder: "https://api.frankfurter.dev/v1/latest?base=USD", icon: "money" },
  { key: "earningsApiUrl", name: "美股财报", desc: "直接拼接日期 YYYY-MM-DD", placeholder: "https://api.nasdaq.com/api/calendar/earnings?date=", icon: "cal" },
  { key: "cnEarningsApiUrl", name: "A股财报", desc: "东方财富预约披露，自动拼接报表参数", placeholder: "https://datacenter.eastmoney.com/securities/api/data/v1/get", icon: "cn" },
  { key: "hkEarningsApiUrl", name: "港股财报", desc: "雪球财报日历（需配置雪球 Cookie），按 begin_date / end_date 取整月", placeholder: "https://stock.xueqiu.com/v5/stock/screener/earnings_calendar/hk/list.json", icon: "hk" },
  { key: "usLogoApiUrl", name: "美股公司图标", desc: "直接拼接代码 .png", placeholder: "https://g.foolcdn.com/art/companylogos/square/", icon: "us" },
  { key: "cnLogoApiUrl", name: "A股公司图标", desc: "自动拼接 代码.SS / 代码.SZ", placeholder: "https://assets.parqet.com/logos/symbol/", icon: "logo" },
  { key: "trumpArchiveApiUrl", name: "特朗普平台归档", desc: "交易广场公开动态来源", placeholder: "https://trumpstruth.org/", icon: "trump" },
  { key: "translationProvider", name: "翻译提供商", desc: "mymemory / deepseek / openai-compatible", placeholder: "deepseek", icon: "translate" },
  { key: "translationApiUrl", name: "动态翻译接口", desc: "免费或自建翻译接口", placeholder: "https://api.mymemory.translated.net/get", icon: "translate" },
  { key: "deepseekApiUrl", name: "DeepSeek API 地址", desc: "OpenAI 兼容 Chat Completions 地址", placeholder: "https://api.deepseek.com/chat/completions", icon: "translate" },
  { key: "deepseekModel", name: "DeepSeek 模型", desc: "默认使用 deepseek-chat", placeholder: "deepseek-chat", icon: "translate" },
  { key: "deepseekApiKey", name: "DeepSeek API Key", desc: "仅服务端使用，不下发浏览器", placeholder: "sk-…", icon: "translate" }
];

const SOURCE_SECTIONS = [
  { id: "sources", icon: "plug", title: "行情与汇率接口", desc: "实时行情、搜索、分时走势与汇率换算", keys: ["quoteApiUrl", "searchApiUrl", "chartApiUrl", "currencyApiUrl"] },
  { id: "source-reports", icon: "source-reports", title: "财报接口", desc: "美股、A 股与港股财报日历数据源", keys: ["earningsApiUrl", "cnEarningsApiUrl", "hkEarningsApiUrl"] },
  { id: "source-icons", icon: "source-icons", title: "公司图标接口", desc: "美股与 A 股公司图标数据源", keys: ["usLogoApiUrl", "cnLogoApiUrl"] },
  { id: "source-content", icon: "source-content", title: "公开内容接口", desc: "原公开动态与翻译数据源", keys: ["trumpArchiveApiUrl", "translationApiUrl"] }
] as const;

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
  hk: (
    <>
      <path d="M3 10 12 4l9 6" />
      <path d="M5 10v9h14v-9" />
      <path d="M10 19v-5h4v5" />
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
export default function SettingsView({ user, recordsCount, onExport, onClearAll, onTabsChange, initialSub, initialSettings, initialPasskeys }: Props) {
  const passkeyData = useMemo(() => createPasskeySettingsData(initialPasskeys), [user.username, user.uid, initialPasskeys]);
  useEffect(() => () => passkeyData.invalidate(), [passkeyData]);
  const isAdminUser = user?.role === "admin";
  const { unit: currencyDisplayUnit, setUnit: setCurrencyDisplayUnit } = useCurrencyDisplayUnit();
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
  const visibleGroups = SUB_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((it) => isAdminUser || !ADMIN_SUB_KEYS.has(it.key)) }))
    .filter((g) => g.items.length > 0);
  // 细粒度侧栏导航：与 ⌘K 搜索索引一致（站点信息/网站形象/首页指数…，各占一项）
  const navGroups = SETTINGS_SEARCH_INDEX
    .filter((it) => isAdminUser || (!ADMIN_SUB_KEYS.has(it.sub) && !it.adminOnly))
    .reduce<{ label: string; items: { sub: SubKey; anchor: string; label: string; groupLabel: string }[] }[]>((acc, it) => {
      const g = acc.find((x) => x.label === it.groupLabel);
      if (g) g.items.push({ sub: it.sub, anchor: it.anchor, label: it.label, groupLabel: it.groupLabel });
      else acc.push({ label: it.groupLabel, items: [{ sub: it.sub, anchor: it.anchor, label: it.label, groupLabel: it.groupLabel }] });
      return acc;
    }, []);
  const canUseWorkspaceUrl = useWorkspaceLocationGuard();
  const searchParams = useSearchParams();
  const initialLocation = resolveSettingsLocation(new URLSearchParams(searchParams.toString()), SETTINGS_SEARCH_INDEX.filter((item) => isAdminUser || (!ADMIN_SUB_KEYS.has(item.sub) && !item.adminOnly)), SETTINGS_CATEGORIES);
  const [sub, setSub] = useState<SubKey>(() => {
    const requested = initialLocation.item?.sub || initialSub;
    const valid = isSettingsSub(requested) ? requested : (isAdminUser ? "site" : "profile");
    return isAdminUser || !ADMIN_SUB_KEYS.has(valid) ? valid : "profile";
  });
  const [activeAnchor, setActiveAnchor] = useState<string>(() => {
    const valid = isSettingsSub(initialSub) ? initialSub : (isAdminUser ? "site" : "profile");
    return initialLocation.item?.anchor || SETTINGS_SEARCH_INDEX.find((x) => x.sub === valid)?.anchor || "info";
  });
  const activeSubMeta = visibleGroups.flatMap((g) => g.items).find((item) => item.key === sub);
  const [categoryPage, setCategoryPage] = useState<string | null>(initialLocation.category);
  useEffect(() => {
    if (categoryPage === "home" || categoryPage === "account") passkeyData.preload();
  }, [categoryPage, passkeyData]);
  const [detailOrigin, setDetailOrigin] = useState<string | null>(() => {
    const origin = searchParams.get("from");
    return origin === "home" || SETTINGS_CATEGORIES.some(item => item.key === origin) ? origin : null;
  });
  const homeIsBackground = categoryPage === "home" || (!categoryPage && detailOrigin === "home");
  const allowedItems = SETTINGS_SEARCH_INDEX.filter((item) => isAdminUser || (!ADMIN_SUB_KEYS.has(item.sub) && !item.adminOnly));
  const categories = SETTINGS_CATEGORIES.map((category) => ({ ...category, items: category.anchors.flatMap((anchor) => allowedItems.filter((item) => item.anchor === anchor)) })).filter((category) => category.items.length > 0);
  const currentCategory = categories.find((category) => category.key === categoryPage || (!categoryPage && category.anchors.includes(activeAnchor)));
  const [site, setSite] = useState<SiteSettings>(() => initialSettings ? {
    ...DEFAULT_SETTINGS,
    ...initialSettings,
    marketBadges: normalizeMarketBadges(initialSettings.marketBadges),
    marketBadgesVisible: initialSettings.marketBadgesVisible !== false
  } : DEFAULT_SETTINGS);
  const settingsSaveGeneration = useRef(0);
  const [tabs, setTabs] = useState<TabConfig[]>(initialSettings?.tabs ?? DEFAULT_TABS);
  const [stockGroups, setStockGroups] = useState<GroupConfig[]>(initialSettings?.groups ?? []);
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
  const pwaIconRef = useRef<HTMLInputElement>(null);
  const [pwaUploading, setPwaUploading] = useState(false);
  const bgRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const loginImgRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const nickInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [me, setMe] = useState({ username: user.username, nickname: user.nickname ?? "", uid: user.uid ?? "", email: user.email ?? "", emailVerified: user.emailVerified === true, avatar: user.avatar ?? "" });
  const [emailVerifyBusy,setEmailVerifyBusy]=useState(false);
  const [emailVerifyMessage,setEmailVerifyMessage]=useState("");
  const [emailVerifyState,setEmailVerifyState]=useState<"ok" | "error">("ok");
  useEffect(()=>{
    let active=true;
    const refresh=async()=>{
      try { const response=await fetch("/api/auth/me",{cache:"no-store"});const data=await response.json();if(active&&response.ok&&data.user)setMe(previous=>({...previous,emailVerified:data.user.emailVerified===true&&data.user.email===previous.email})); } catch {}
    };
    void refresh();window.addEventListener("focus",refresh);window.addEventListener("fire:user-updated",refresh);
    return()=>{active=false;window.removeEventListener("focus",refresh);window.removeEventListener("fire:user-updated",refresh);};
  },[]);
  async function sendEmailConfirmation() {
    if(emailVerifyBusy) return;
    setEmailVerifyBusy(true);setEmailVerifyMessage("");setEmailVerifyState("ok");
    try {const response=await fetch("/api/auth/email-verification/request",{method:"POST"});const data=await response.json().catch(()=>null);if(!response.ok)throw new Error(data?.error||"发送失败");setEmailVerifyMessage(data?.verified?"邮箱已验证":"确认链接已发送，请在邮箱中点击验证。");if(data?.verified)setMe(previous=>({...previous,emailVerified:true}));showToast(data?.verified?"邮箱已验证":"确认邮件已发送");}
    catch(error){const text=error instanceof Error?error.message:"发送失败";setEmailVerifyState("error");setEmailVerifyMessage(text);showToast(text,"err");}
    finally{setEmailVerifyBusy(false);}
  }
  const [nickname, setNickname] = useState(user.nickname ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [nickMsg, setNickMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    const openPalette = () => { jumpTo({ sub: "palette", anchor: "palette", label: "外观" }); };
    window.addEventListener("fire:open-palette", openPalette);
    return () => window.removeEventListener("fire:open-palette", openPalette);
  }, []);
  const [versionOpen, setVersionOpen] = useState(false);
  const tabDragIndex = useRef<number | null>(null);
  const groupDragIndex = useRef<number | null>(null);
  const navDragIndex = useRef<number | null>(null);
  const tickerDragIndex = useRef<number | null>(null);

  useLayoutEffect(() => {
    function restoreLocation() {
      if (!canUseWorkspaceUrl()) return;
      const location = resolveSettingsLocation(new URLSearchParams(window.location.search), SETTINGS_SEARCH_INDEX.filter((item) => isAdminUser || (!ADMIN_SUB_KEYS.has(item.sub) && !item.adminOnly)), SETTINGS_CATEGORIES);
      setCategoryPage(location.category);
      const origin = new URLSearchParams(window.location.search).get("from");
      setDetailOrigin(origin === "home" || SETTINGS_CATEGORIES.some(item => item.key === origin) ? origin : null);
      if (location.item && isSettingsSub(location.item.sub)) {
        setSub(location.item.sub);
        setActiveAnchor(location.item.anchor);
      }
    }
    restoreLocation();
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [initialSub, isAdminUser]);

  useEffect(() => {
    const generation = settingsSaveGeneration.current;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (generation !== settingsSaveGeneration.current) return;
        if (data?.settings) {
          setSite({ ...DEFAULT_SETTINGS, ...data.settings, marketBadges: normalizeMarketBadges(data.settings.marketBadges), marketBadgesVisible: data.settings.marketBadgesVisible !== false });
          captureSaved(data.settings);
          setTabs(data.settings.tabs ?? DEFAULT_TABS);
          setStockGroups(data.settings.groups ?? []);
          setGroupsLoaded(true);
          applyMarketBadges(data.settings.marketBadges, data.settings.marketBadgesVisible !== false);
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

  async function uploadSiteFile(kind: "ico" | "background", file: File, target?: "pwaIcon" | "appDisplayIcon"): Promise<string> {
    if (target) setPwaUploading(true);
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "上传失败");
      setSite((s) => ({ ...s, [target || kind]: data.url }));
      return data.url as string;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "上传失败", "err");
      return "";
    } finally { if (target) setPwaUploading(false); }
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

  async function uploadModelIcon(file: File, name: string, serviceId: string, services: ModelServiceConfig[]): Promise<SiteSettings> {
    const fd = new FormData();
    fd.set("kind", "asset");
    fd.set("folder", "icon");
    fd.set("name", name || "模型服务");
    // 服务与上传批次共同组成文件名，避免不同服务共享 URL 或命中旧图片缓存。
    fd.set("code", `${serviceId.slice(0, 20)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    fd.set("serviceId", serviceId);
    fd.set("modelServices", JSON.stringify(services));
    fd.set("file", file);
    const res = await fetch("/api/settings/model-icon", { method: "POST", body: fd });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.url || !data?.settings) throw new Error(data?.error || "图标上传失败");
    return data.settings as SiteSettings;
  }

  async function testModelService(service: ModelServiceConfig, model: string) {
    const key = `${service.id}:${model}`;
    setModelTestStates(current => ({ ...current, [key]: { state: "loading", text: "测试中" } }));
    try {
      const res = await fetch("/api/settings/model-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: service.id, provider: service.provider, apiUrl: service.apiUrl, apiKey: service.apiKey, model })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "测试失败");
      setModelTestStates(current => ({ ...current, [key]: { state: "ok", text: `${data.latencyMs}ms` } }));
    } catch (error) {
      setModelTestStates(current => ({ ...current, [key]: { state: "error", text: error instanceof Error ? error.message : "测试失败" } }));
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

  async function saveBlock(key: string, fields: Partial<SiteSettings>, hint: string, signal?: AbortSignal) {
    setBlockSaving((b) => ({ ...b, [key]: true }));
    setBlockMsg((m) => ({ ...m, [key]: undefined }));
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "same-origin",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields)
      });
      const data = await readLimitedResponseJson<any>(res, 1024 * 1024);
      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error.slice(0, 200) : "保存失败");
      if (!data?.settings || typeof data.settings !== "object" || Array.isArray(data.settings) || typeof data.settings.domain !== "string" || !Array.isArray(data.settings.tabs)) throw new Error("保存结果无效，请刷新核对后重试");
      settingsSaveGeneration.current += 1;
      setSite((s) => ({ ...s, ...data.settings, llmApiKey: s.llmApiKey }));
      captureSaved(data.settings);
      if (data.settings?.marketBadges || typeof data.settings?.marketBadgesVisible === "boolean") {
        applyMarketBadges(data.settings.marketBadges, data.settings.marketBadgesVisible);
      }
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

  /* Site information and the standalone visibility switch auto-save; editors require Save. */
  const savedRef = useRef<Record<string, unknown> | null>(null);
  // 上次保存成功的完整设置（取消用）；tabsRef 同步 tabs，避免闭包拿到旧值
  const lastSavedRef = useRef<{ site: SiteSettings; tabs: TabConfig[] } | null>(null);
  const tabsRef = useRef<TabConfig[]>(tabs);
  tabsRef.current = tabs;

  function autoSaveSnapshot(s: SiteSettings) {
    return {
      title: s.title,
      domain: s.domain,
      allowRegister: s.allowRegister,
      footerDesc: s.footerDesc,
      marketBadgesVisible: s.marketBadgesVisible !== false,
    };
  }

  function captureSaved(s: SiteSettings) {
    savedRef.current = autoSaveSnapshot(s);
    // 「取消」要回滚的是「上次保存成功」的完整状态，所以这里额外存一份深拷贝（含 tabs 等独立状态）
    try {
      lastSavedRef.current = {
        site: JSON.parse(JSON.stringify(s)) as SiteSettings,
        tabs: JSON.parse(JSON.stringify((s as { tabs?: TabConfig[] }).tabs ?? tabsRef.current)) as TabConfig[]
      };
    } catch {
      /* 深拷贝失败（循环引用等）时放弃本次快照，取消按钮会退化为仅退出编辑 */
    }
  }

  useEffect(() => {
    if (!savedRef.current) return;
    const saved = savedRef.current;
    const cur = autoSaveSnapshot(site) as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    Object.keys(cur).forEach((key) => {
      if (key === "marketBadgesVisible" && editingMarketBadges) return;
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
        const keys = Object.keys(patch);
        const savedMessage =
          keys.length === 1 && keys[0] === "marketBadgesVisible"
            ? patch.marketBadgesVisible ? "市场色块已显示" : "市场色块已隐藏"
            : keys.length === 1 && keys[0] === "allowRegister"
              ? patch.allowRegister ? "已允许新用户注册" : "已关闭新用户注册"
              : "设置已自动保存";
        showToast(savedMessage);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "保存失败，请稍后重试", "err");
      }
    }, 700);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  async function resetBrand() {
    if (!await appConfirm("将清空自定义网站图片，Logo 文字恢复为 Alcor。应用授权配置不受影响。", { title: "恢复默认网站形象", danger: true })) return;
    const ok = await saveBlock("brand", { ico: "", pwaIcon: "", siteLogo: "", logoText: "Alcor", logoFont: "diatype", homepageBg: "", loginSideImage: "" }, "网站形象已重置");
    if (ok) setEditingAppearance(false);
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
      setMe({ username: meData.user.username, nickname: meData.user.nickname ?? "", uid: meData.user.uid ?? "", email: meData.user.email ?? "", emailVerified: meData.user.emailVerified === true, avatar: meData.user.avatar });
      setNickname(meData.user.nickname ?? "");
      setEmail(meData.user.email ?? "");
      window.dispatchEvent(new Event("fire:user-updated"));
      setAvatarMsg({ type: "ok", text: "头像已更新，右上角已同步" });
      showToast("头像已更新");
    } catch (err) {
      const message = err instanceof Error ? err.message : "头像上传失败";
      setAvatarMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setAvatarUploading(false);
    }
  }

  const profileSavingRef = useRef(false);
  const [profileSaving, setProfileSaving] = useState(false);
  async function saveProfile() {
    if (profileSavingRef.current) return;
    profileSavingRef.current = true;
    setProfileSaving(true);
    setNickMsg(null);
    try {
      const res = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, email, currentPassword: profilePassword })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      if (!data?.user) throw new Error("保存失败，请重试");
      const changedEmail=(data.user.email ?? "").toLowerCase()!==(me.email ?? "").toLowerCase();
      setMe((m) => ({ ...m, nickname: data.user.nickname, email: data.user.email, emailVerified: data.user.emailVerified===true }));
      setNickname(data.user.nickname);
      setEmail(data.user.email);
      setProfilePassword("");
      window.dispatchEvent(new Event("fire:user-updated"));
      setNickMsg({ type: "ok", text: "个人资料已更新" });
      showToast("个人资料已更新");
      setEditingProfile(false);
      if(changedEmail && data.user.email && !data.user.emailVerified) void sendEmailConfirmation();
    } catch (err) {
      const message = err instanceof TypeError ? "连接失败，请重试" : err instanceof Error ? err.message : "保存失败，请重试";
      setNickMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      profileSavingRef.current = false;
      setProfileSaving(false);
    }
  }

  async function exportSiteBackup() {
    if (!await appConfirm("备份包含全部站点配置与用户数据，请妥善保管。", { title: "导出网站数据" })) return;
    setBackupBusy("export");
    try {
      const res = await fetch("/api/v1/data/export");
      if (!res.ok) throw new Error("导出失败");
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `alcor-backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
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
      showToast("文件解析失败，请选择 Alcor 或旧版备份 JSON", "err");
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
      if (!await appConfirm(`${summary}\n\n数据将按 id 合并，导入前会自动备份当前数据库。`, { title: "导入网站数据" })) return;
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
      const res = await fetch("/api/v1/auth/delete-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: deletePassword, code: deleteTotpCode }) });
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
    setEditingStockGroups(true);
    setStockGroups((prev) => [...prev, { id: `g${Date.now()}-${prev.length}`, name: "新券商", alias: "" }]);
  }

  const [groupMsg, setGroupMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [editingStockGroups, setEditingStockGroups] = useState(false);
  const [editingTicker, setEditingTicker] = useState(false);
  const [editingHomeNav, setEditingHomeNav] = useState(false);
  const [editingTabs, setEditingTabs] = useState(false);
  const [editingSources, setEditingSources] = useState(false);
  const [editingModel, setEditingModel] = useState(false);
  const [uploadingModelIconId, setUploadingModelIconId] = useState<string | null>(null);
  const modelDragIndexRef = useRef<number | null>(null);
  const [modelTestStates, setModelTestStates] = useState<Record<string, { state: "loading" | "ok" | "error"; text: string }>>({});
  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/model-test")
      .then(response => response.ok ? response.json() : null)
      .then((data: { tests?: Record<string, { ok: boolean; latencyMs: number; error?: string }> } | null) => {
        if (cancelled || !data?.tests) return;
        const restored = Object.fromEntries(Object.entries(data.tests).map(([key, result]) => [key, {
          state: result.ok ? "ok" as const : "error" as const,
          text: result.ok ? `${result.latencyMs}ms` : result.error || "上次测试失败"
        }]));
        setModelTestStates(current => ({ ...restored, ...current }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [editingTradingSquare, setEditingTradingSquare] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  // 站点信息：不再有「编辑 / 保存」两步 —— 字段常驻可编辑，改动由全局自动保存（700ms 防抖 + 胶囊提示）落库
  const [editingSiteInfo] = useState(true);
  const [editingFutu, setEditingFutu] = useState(false);
  const [editingMarketBadges, setEditingMarketBadges] = useState(false);
  const [editingAppearance, setEditingAppearance] = useState(false);
  const [editingDb, setEditingDb] = useState(false);
  const activeEditState = activeAnchor === "trading-square" ? editingTradingSquare
    : activeAnchor === "info" ? editingSiteInfo
    : activeAnchor === "appearance" ? editingAppearance
      : activeAnchor === "ticker" ? editingTicker
        : activeAnchor === "nav" ? editingHomeNav
          : activeAnchor === "app-nav" ? editingTabs
          : activeAnchor === "groups" ? editingStockGroups
            : activeAnchor === "market-badges" ? editingMarketBadges
            : SOURCE_DETAIL_ANCHORS.has(activeAnchor) ? editingSources
              : activeAnchor === "translation" ? editingModel
              : activeAnchor === "trade" ? editingFutu
                : activeAnchor === "profile" ? editingProfile
                  : activeAnchor === "database" ? editingDb
                    : false;
  const activePageMeta = SETTINGS_SEARCH_INDEX.find((item) => item.sub === sub && item.anchor === activeAnchor);

  function beginActiveEdit() {
    if (activeAnchor === "trading-square") setEditingTradingSquare(true);
    // info 分区常驻可编辑（自动保存），无需进入编辑态
    else if (activeAnchor === "appearance") setEditingAppearance(true);
    else if (activeAnchor === "ticker") setEditingTicker(true);
    else if (activeAnchor === "nav") setEditingHomeNav(true);
    else if (activeAnchor === "app-nav") setEditingTabs(true);
    else if (activeAnchor === "groups") setEditingStockGroups(true);
    else if (activeAnchor === "market-badges") setEditingMarketBadges(true);
    else if (SOURCE_DETAIL_ANCHORS.has(activeAnchor)) setEditingSources(true);
    else if (activeAnchor === "translation") setEditingModel(true);
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
    window.dispatchEvent(new CustomEvent("fire:settings-edit-state", { detail: { editing: activeEditState, auto: ["info", "palette", "passkeys"].includes(activeAnchor) } }));
  }, [activeEditState, activeAnchor]);
  const saveActiveEditRef = useRef<() => Promise<void>>(async () => {});
  const savingEditRef = useRef(false);
  async function saveActiveEdit() {
    if (savingEditRef.current || !activeEditState) return;
    if (activeAnchor === "appearance" && pwaUploading) { showToast("图标正在上传，请稍候", "err"); return; }
    if (activeAnchor === "translation" && uploadingModelIconId) {
      showToast("图标正在上传并保存，请稍候", "err");
      return;
    }
    savingEditRef.current = true;
    try {
      if (activeAnchor === "trading-square") {
        const ok = await saveBlock("tradingSquare", {
          tradingSquareTrumpRefreshMinutes: site.tradingSquareTrumpRefreshMinutes,
          tradingSquareDuanRefreshMinutes: site.tradingSquareDuanRefreshMinutes
        }, "交易广场更新频率已保存");
        if (ok) setEditingTradingSquare(false);
      } else if (activeAnchor === "info") {
        const ok = await saveBlock("siteInfo", { title: site.title, domain: site.domain, allowRegister: site.allowRegister, footerDesc: site.footerDesc }, "站点信息已保存");
        // 站点信息是常驻可编辑 + 自动保存，不再有「保存后转只读」这一步
      } else if (activeAnchor === "appearance") {
        const ok = await saveBlock("brand", { ico: site.ico, pwaIcon: site.pwaIcon, siteLogo: site.siteLogo, logoText: site.logoText, logoFont: site.logoFont, homepageBg: site.homepageBg, loginSideImage: site.loginSideImage }, "网站形象已保存");
        if (ok) setEditingAppearance(false);
      } else if (activeAnchor === "ticker") {
        const ok = await saveBlock("ticker", { ticker: site.ticker }, "首页指数已保存");
        if (ok) setEditingTicker(false);
      } else if (activeAnchor === "nav") {
        const ok = await saveBlock("navigation", { homeNav: site.homeNav }, "首页导航已保存");
        if (ok) setEditingHomeNav(false);
      } else if (activeAnchor === "app-nav") {
        const ok = await saveBlock("tabs", { tabs }, "应用导航已保存");
        if (ok) setEditingTabs(false);
      } else if (activeAnchor === "groups") {
        await saveStockGroups();
      } else if (activeAnchor === "market-badges") {
        const nextBadges = normalizeMarketBadges(site.marketBadges);
        const ok = await saveBlock("marketBadges", { marketBadges: nextBadges, marketBadgesVisible: site.marketBadgesVisible !== false }, "市场色块已保存");
        if (ok) {
          applyMarketBadges(nextBadges, site.marketBadgesVisible !== false);
          setEditingMarketBadges(false);
        }
      } else if (SOURCE_DETAIL_ANCHORS.has(activeAnchor)) {
        const ok = await saveStockSources();
        if (ok) setEditingSources(false);
      } else if (activeAnchor === "translation") {
        const ok = await saveBlock("model", {
          modelServices: site.modelServices
        }, "模型服务已保存");
        if (ok) setEditingModel(false);
      } else if (activeAnchor === "trade") {
        const ok = await saveBlock("futu", { futuHost: site.futuHost, futuPort: site.futuPort, quoteSource: site.quoteSource }, "交易与行情源设置已保存");
        if (ok) setEditingFutu(false);
      } else if (activeAnchor === "profile") {
        await saveProfile();
      } else if (activeAnchor === "database") {
        const ok = await saveDb();
        if (ok) setEditingDb(false);
      }
    } finally {
      savingEditRef.current = false;
    }
  }

  /** 取消：回滚到上次保存成功的完整状态并退出编辑（主流做法里「取消 + 保存」成对出现） */
  function exitActiveEdit() {
    if (activeAnchor === "trading-square") setEditingTradingSquare(false);
    else if (activeAnchor === "appearance") setEditingAppearance(false);
    else if (activeAnchor === "ticker") setEditingTicker(false);
    else if (activeAnchor === "nav") setEditingHomeNav(false);
    else if (activeAnchor === "app-nav") setEditingTabs(false);
    else if (SOURCE_DETAIL_ANCHORS.has(activeAnchor)) setEditingSources(false);
    else if (activeAnchor === "translation") setEditingModel(false);
    else if (activeAnchor === "trade") setEditingFutu(false);
    else if (activeAnchor === "market-badges") setEditingMarketBadges(false);
    else if (activeAnchor === "groups") setEditingStockGroups(false);
    else if (activeAnchor === "profile") setEditingProfile(false);
    else if (activeAnchor === "database") setEditingDb(false);
  }
  function cancelActiveEdit() {
    const snapshot = lastSavedRef.current;
    if (snapshot) {
      setSite(snapshot.site);
      setTabs(snapshot.tabs);
      captureSaved(snapshot.site);
    }
    exitActiveEdit();
    showToast("已取消未保存的修改");
  }
  const EDIT_CANCEL_BUTTON = (
    <button type="button" onClick={cancelActiveEdit} className="btn btn-ghost btn-sm">取消</button>
  );

  saveActiveEditRef.current = saveActiveEdit;

  // 标题栏的完成图标与卡片保存共用同一提交链路；失败时保留编辑态。
  useEffect(() => {
    const onComplete = () => { void saveActiveEditRef.current(); };
    window.addEventListener("fire:settings-edit-complete", onComplete);
    return () => window.removeEventListener("fire:settings-edit-complete", onComplete);
  }, []);
  const [backupBusy, setBackupBusy] = useState<"export" | "import" | null>(null);
  const importBackupRef = useRef<HTMLInputElement | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteTotpCode, setDeleteTotpCode] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [srcMsg, setSrcMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [srcSaving, setSrcSaving] = useState(false);
  const [futuOnline, setFutuOnline] = useState<boolean | null>(null);
  const [futuSkipped, setFutuSkipped] = useState(false);
  const [futuTest, setFutuTest] = useState<{ busy: boolean; ok?: boolean; msg?: string } | null>(null);
  const [futuQuota, setFutuQuota] = useState<{
    loading: boolean;
    data?: {
      subscription?: { totalUsed: number; remain: number; ownUsed: number; totalQuota: number; ownTotalQuota: number };
      historyKl?: { used: number; remain: number; totalQuota: number };
    } | null;
    ok?: boolean;
    at?: number;
  }>({ loading: false, data: null });
  useLayoutEffect(() => {
    // 缓存只在挂载后恢复，避免浏览器首帧与服务端不同；不自动查询接口。
    try {
      const raw = localStorage.getItem("fire:futu-quota");
      if (raw) {
        const saved = JSON.parse(raw) as { data?: unknown; at?: number };
        if (saved?.data && typeof saved.at === "number") {
          setFutuQuota({
            loading: false,
            data: saved.data as {
              subscription?: { totalUsed: number; remain: number; ownUsed: number; totalQuota: number; ownTotalQuota: number };
              historyKl?: { used: number; remain: number; totalQuota: number };
            },
            ok: true,
            at: saved.at
          });
        }
      }
    } catch {
      /* 缓存损坏时忽略 */
    }
  }, []);

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
        if (!cancelled) {
          setFutuOnline(Boolean(data?.data?.futuOpenD?.available));
          setFutuSkipped(Boolean(data?.data?.futuOpenD?.skipped));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveStockSources(): Promise<boolean> {
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
          currencyRefreshPattern: site.currencyRefreshPattern,
          earningsApiUrl: site.earningsApiUrl,
          cnEarningsApiUrl: site.cnEarningsApiUrl,
          hkEarningsApiUrl: site.hkEarningsApiUrl,
          usLogoApiUrl: site.usLogoApiUrl,
          cnLogoApiUrl: site.cnLogoApiUrl,
          translationProvider: site.translationProvider,
          trumpArchiveApiUrl: site.trumpArchiveApiUrl,
          translationApiUrl: site.translationApiUrl,
          deepseekApiUrl: site.deepseekApiUrl,
          deepseekModel: site.deepseekModel
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "保存失败");
      setSite((s) => ({ ...s, ...data.settings }));
      captureSaved(data.settings);
      window.dispatchEvent(new Event("fire:settings-updated"));
      setSrcMsg({ type: "ok", text: "股票来源接口已保存，行情 / 财报 / 图标即时生效" });
      showToast("股票来源接口已保存");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "行情与汇率接口保存失败";
      setSrcMsg({ type: "err", text: message });
      showToast(message, "err");
      return false;
    } finally {
      setSrcSaving(false);
    }
  }

  async function saveStockGroups() {
    // 防误清：券商列表为空且当前已有券商时，先二次确认（避免清空所有持仓记录的券商）
    if (stockGroups.length === 0 && (site.groups?.length ?? 0) > 0) {
      if (!await appConfirm("保存后将删除全部券商，并清空所有持仓记录的券商。", { title: "清空券商列表", danger: true })) return;
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
      const message = err instanceof Error ? err.message : "券商设置保存失败";
      setGroupMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setGroupSaving(false);
    }
  }

  async function saveDb(): Promise<boolean> {
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
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "数据库配置保存失败";
      setDbMsg({ type: "err", text: message });
      showToast(message, "err");
      return false;
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
      const message = res.ok ? `数据库连接成功：${data?.version ?? "已建立连接"}` : (data?.error ?? "数据库连接失败，请检查地址、端口和账号");
      setDbMsg({
        type: res.ok ? "ok" : "err",
        text: message
      });
      showToast(message, res.ok ? "ok" : "err");
    } catch {
      const message = "数据库连接失败，请检查网络与服务器配置";
      setDbMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setDbTesting(false);
    }
  }

  /* ---------- 修改密码 ---------- */
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signOutOtherDevices, setSignOutOtherDevices] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [mailTesting, setMailTesting] = useState(false);
  const [mailResult, setMailResult] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    setMailResult(null);
  }, [site.smtpHost, site.smtpPort, site.smtpSecure, site.smtpUser, site.smtpPassword, site.smtpFromName, site.smtpFromEmail, site.emailLinkOrigin]);

  async function testMailSettings() {
    if (mailTesting || blockSaving.mail) return;
    setMailTesting(true);
    setMailResult(null);
    try {
      const response = await fetch("/api/settings/mail-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smtpHost: site.smtpHost, smtpPort: site.smtpPort, smtpSecure: site.smtpSecure, smtpUser: site.smtpUser, smtpPassword: site.smtpPassword, smtpFromName: site.smtpFromName, smtpFromEmail: site.smtpFromEmail })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "测试失败，请检查邮件配置");
      setMailResult({ type: "ok", text: `已发送至 ${data.email}。确认收到后保存。` });
      showToast("测试邮件已发送");
    } catch (error) {
      const text = error instanceof Error ? error.message : "测试失败，请重试";
      setMailResult({ type: "err", text });
      showToast(text, "err");
    } finally { setMailTesting(false); }
  }
  const [passwordRecoveryOpen, setPasswordRecoveryOpen] = useState(false);
  const [passwordRecoveryBusy, setPasswordRecoveryBusy] = useState(false);
  const [profilePassword, setProfilePassword] = useState("");
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [totpStatusLoaded, setTotpStatusLoaded] = useState(false);
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; qrPng: string; otpauthUrl: string } | null>(null);
  const [totpLandingStage, setTotpLandingStage] = useState<"intro" | "method">("intro");
  const [totpDeviceName, setTotpDeviceName] = useState("");
  const [totpSetupStage, setTotpSetupStage] = useState<"instructions" | "name" | "verify">("instructions");
  const [totpSetupCode, setTotpSetupCode] = useState("");
  const [totpReauthNeeded, setTotpReauthNeeded] = useState(false);
  const totpActionLock = useRef(false);
  const [totpBackupCodes, setTotpBackupCodes] = useState<string[] | null>(null);
  const [totpDisablePassword, setTotpDisablePassword] = useState("");
  const [totpDisableCode, setTotpDisableCode] = useState("");
  const [totpPasswordCode, setTotpPasswordCode] = useState("");
  const [totpMsg, setTotpMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [totpLearnMore, setTotpLearnMore] = useState(false);

  useEffect(() => {
    fetch("/api/auth/totp", { cache: "no-store", credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.enabled === "boolean") setTotpEnabled(data.enabled);
        if (typeof data?.name === "string") setTotpDeviceName(data.name);
      })
      .catch(() => {})
      .finally(() => setTotpStatusLoaded(true));
  }, []);

  async function startTotpSetup() {
    if (totpBusy || totpActionLock.current || totpSetup) return;
    totpActionLock.current = true;
    setTotpMsg(null);
    setTotpBusy(true);
    try {
      const res = await fetch("/api/auth/totp", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}", signal: AbortSignal.timeout(20_000) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "无法开始绑定");
      setTotpSetup({
        secret: String(data.secret || ""),
        qrPng: String(data.qrPng || ""),
        otpauthUrl: String(data.otpauthUrl || "")
      });
      setTotpSetupCode("");
      setTotpSetupStage("instructions");
      setTotpDeviceName("");
      setTotpReauthNeeded(false);
      setTotpBackupCodes(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "无法开始双重验证设置";
      setTotpMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setTotpBusy(false);
      totpActionLock.current = false;
    }
  }

  async function confirmTotpSetup(e?: React.FormEvent) {
    e?.preventDefault();
    if (totpBusy || totpActionLock.current || totpSetupStage !== "verify" || !totpDeviceName.trim() || !isSixDigitTotp(totpSetupCode)) return;
    totpActionLock.current = true;
    setTotpMsg(null);
    setTotpBusy(true);
    try {
      const password = totpReauthNeeded ? await appPrompt("登录已过较久，请重新验证身份", { title: "安全验证", placeholder: "当前密码" }) : "";
      if (totpReauthNeeded && !password) return;
      const res = await fetch("/api/auth/totp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: totpSetupCode, name: totpDeviceName.trim(), ...(password ? { password } : {}) }),
        signal: AbortSignal.timeout(20_000)
      });
      const data = await res.json().catch(() => null);
      if (data?.requiresReauthentication) setTotpReauthNeeded(true);
      if (!res.ok) throw new Error(data?.error || "验证失败");
      setTotpEnabled(true);
      setTotpSetup(null);
      setTotpSetupStage("instructions");
      setTotpSetupCode("");
      setTotpReauthNeeded(false);
      setTotpBackupCodes(Array.isArray(data?.backupCodes) ? data.backupCodes : []);
      setTotpMsg({ type: "ok", text: "二次验证已开启。密钥不再显示，请保存备用码。其它设备需要重新登录。" });
      showToast("二次验证已开启，请保存备用码");
    } catch (err) {
      const message = err instanceof Error ? err.message : "验证码校验失败";
      setTotpMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setTotpBusy(false);
      totpActionLock.current = false;
    }
  }

  function downloadBackupCodes() {
    if (!totpBackupCodes?.length) return;
    const body = `Alcor 二次验证备用码\n每条只能用一次，请妥善保存。\n\n${totpBackupCodes.join("\n")}\n`;
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "alcor-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
    showToast("备用码已下载");
  }

  async function copySecurityText(text: string, label: string) {
    const copied = await copyText(text);
    showToast(copied ? `${label}已复制` : `${label}复制失败，请手动选择复制`, copied ? "ok" : "err");
  }

  async function disableTotp(e: React.FormEvent) {
    e.preventDefault();
    setTotpMsg(null);
    setTotpBusy(true);
    try {
      const res = await fetch("/api/auth/totp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: totpDisablePassword, code: totpDisableCode })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "关闭失败");
      setTotpEnabled(false);
      setTotpLandingStage("intro"); setTotpDeviceName("");
      setTotpDisablePassword("");
      setTotpDisableCode("");
      setTotpBackupCodes(null);
      setTotpSetup(null);
      setTotpSetupStage("instructions");
      setTotpMsg({ type: "ok", text: "二次验证已关闭" });
      showToast("二次验证已关闭");
    } catch (err) {
      const message = err instanceof Error ? err.message : "双重验证关闭失败";
      setTotpMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setTotpBusy(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwdMsg(null);
    if (newPassword !== confirmPassword) {
      const message = "两次输入的新密码不一致，请重新确认";
      setPwdMsg({ type: "err", text: message });
      showToast(message, "err");
      return;
    }
    setPwdBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword, code: totpPasswordCode, signOutOthers: signOutOtherDevices })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "修改失败");
      setPwdMsg({ type: "ok", text: "密码修改成功，下次登录请使用新密码" });
      showToast("密码修改成功");
      setOldPassword(""); setNewPassword(""); setConfirmPassword(""); setTotpPasswordCode(""); setSignOutOtherDevices(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "密码修改失败";
      setPwdMsg({ type: "err", text: message });
      showToast(message, "err");
    } finally {
      setPwdBusy(false);
    }
  }

  function openPasswordRecovery() {
    if (!totpEnabled && (!me.email.trim() || !me.emailVerified)) {
      setPasswordRecoveryOpen(false);
      setNickMsg({ type: "err", text: me.email ? "请先点击确认邮件中的链接，验证邮箱。" : "请先绑定邮箱，保存后验证邮箱。" });
      jumpTo({ sub: "profile", anchor: "profile", label: "个人信息" });
      setEditingProfile(!me.email);
      setTimeout(() => emailInputRef.current?.focus(), 80);
      showToast(me.email ? "请先验证邮箱" : "请先绑定邮箱");
      return;
    }
    setPasswordRecoveryOpen(true);
  }


  const [clearing, setClearing] = useState(false);
  async function clearAll() {
    if (!await appConfirm(`将清空全部 ${recordsCount} 条记录，此操作无法恢复。`, { title: "清空全部记录", danger: true })) return;
    const password = await appPrompt("请输入当前密码以继续", { title: "安全验证", placeholder: "当前密码" });
    if (!password) return;
    setClearing(true);
    await onClearAll(password);
    setClearing(false);
  }

  function syncSettingsUrl(nextSub: SubKey, anchor: string) {
    const url = new URL(window.location.href);
    url.searchParams.delete("category");
    url.searchParams.delete("panel");
    url.searchParams.set("sub", nextSub);
    const origin = categoryPage || detailOrigin;
    if (origin) url.searchParams.set("from", origin);
    else url.searchParams.delete("from");
    if (persistSettingsAnchor(nextSub, anchor)) url.searchParams.set("anchor", anchor);
    else url.searchParams.delete("anchor");
    // Next.js copies its own history fields; passing __NA ourselves skips router URL synchronization.
    if (url.href !== window.location.href) window.history.pushState(null, "", url.toString());
  }

  function openCategory(key: string) {
    if (categoryPage === key) return;
    setCategoryPage(key);
    setDetailOrigin(null);
    setCmdQuery("");
    setCmdOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("sub");
    url.searchParams.delete("panel");
    url.searchParams.delete("anchor");
    url.searchParams.delete("from");
    if (key === "home") url.searchParams.delete("category");
    else url.searchParams.set("category", key);
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    contentScrollRef.current?.scrollTo({ top: 0 });
  }

  /* ---------- ⌘K / 侧栏搜索 ---------- */
  const cmdRef = useRef<HTMLInputElement | null>(null);
  const sidebarSearchRef = useRef<HTMLInputElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);

  function openCmdPalette() {
    setCmdIndex(0);
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
      sidebarSearchRef.current?.focus();
      sidebarSearchRef.current?.select();
      return;
    }
    setCmdOpen(true);
    setTimeout(() => cmdRef.current?.focus(), 0);
  }

  const cmdResults = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    if (!q) return [];
    return SETTINGS_SEARCH_INDEX.filter((item) => {
      if (!isAdminUser && ADMIN_SUB_KEYS.has(item.sub)) return false;
      const hay = `${item.label} ${item.groupLabel} ${item.keywords}`.toLowerCase();
      return [...q].every((ch) => hay.includes(ch)) || hay.includes(q);
    });
  }, [cmdQuery, isAdminUser]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCmdPalette();
      } else if (e.key === "Escape") {
        setCmdOpen(false);
        setCmdQuery("");
        cmdRef.current?.blur();
        sidebarSearchRef.current?.blur();
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

  const visibleNavGroups = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    if (!q) return navGroups;
    const matched = new Set(
      SETTINGS_SEARCH_INDEX.filter((item) => {
        const hay = `${item.label} ${item.groupLabel} ${item.keywords}`.toLowerCase();
        return hay.includes(q);
      }).map((item) => item.sub + item.anchor)
    );
    return navGroups
      .map((group) => ({ ...group, items: group.items.filter((item) => matched.has(item.sub + item.anchor)) }))
      .filter((group) => group.items.length > 0);
  }, [navGroups, cmdQuery]);

  function jumpTo(item: { sub: SubKey; anchor: string; label: string }) {
    if (!isAdminUser && ADMIN_SUB_KEYS.has(item.sub)) return;
    setCmdOpen(false);
    setCmdQuery("");
    setDetailOrigin(categoryPage || detailOrigin);
    setCategoryPage(null);
    setSub(item.sub);
    setActiveAnchor(item.anchor);
    syncSettingsUrl(item.sub, item.anchor);
    contentScrollRef.current?.scrollTo({ top: 0 });
  }

  const categoryList = <>{currentCategory?.key === "account" && <SecurityCheck onNavigate={anchor => { const item = currentCategory.items.find(item => item.anchor === anchor); if (item) jumpTo(item); }} />}{(currentCategory?.key === "account" ? [
    { title: "个人资料", desc: "头像、昵称与邮箱", items: currentCategory.items.filter((item) => item.anchor === "profile") },
    { title: "账户登录", desc: "密码、验证器与通行密钥", items: currentCategory.items.filter((item) => item.anchor !== "profile" && item.anchor !== "authorizations") },
    { title: "应用授权", desc: "", items: currentCategory.items.filter((item) => item.anchor === "authorizations") }
  ] : [{ title: "", desc: "", items: currentCategory?.items || [] }]).map((group, index) => <section className="sc-category-section" key={index}>
    {group.title && <><h3>{group.title}</h3><p>{group.desc}</p></>}
    <div className="sc-row-group">{group.items.map((item) => <button type="button" className="sc-setting-row" key={item.anchor} onClick={() => jumpTo(item)}><span><strong>{item.label}</strong>{item.anchor === "passkeys" && <span className="sc-passkey-recommendation">推荐</span>}</span><span className="sc-chevron" aria-hidden="true">›</span></button>)}</div>
  </section>)}</>;

  const homeLanding = <div className="sc-landing sc-home-landing">
    <button type="button" className="sc-account-card" onClick={() => jumpTo({ sub: "profile", anchor: "profile", label: "个人信息" })}>
      {me.avatar ? <img src={me.avatar} alt=""/> : <span className="sc-avatar-placeholder">{(me.nickname || me.username).slice(0, 1)}</span>}
      <span><strong>{me.email || me.nickname || me.username}</strong></span><span className="sc-chevron" aria-hidden="true">›</span>
    </button>
    <SecurityCheck onNavigate={anchor => jumpTo({ sub: anchor, anchor, label: anchor === "profile" ? "个人信息" : anchor === "totp" ? "双重验证" : "通行密钥" })} />
    <nav className="sc-mobile-navigation sc-row-group" aria-label="手机设置分类">
      {categories.map(category => <button type="button" className="sc-setting-row" key={category.key} onClick={() => openCategory(category.key)}><SubNavIcon name={category.icon} className="h-5 w-5"/><span><strong>{category.label}</strong></span><span className="sc-chevron" aria-hidden="true">›</span></button>)}
    </nav>
  </div>;
  const detailBackground = detailOrigin === "home" ? homeLanding : <div className="sc-landing">{categoryList}</div>;

  return (
    <div className="settings-page flex h-full min-h-0 flex-1">
      {showDeleteConfirm && createPortal(
        <div data-priority-modal="true" className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="确认注销账号" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowDeleteConfirm(false); setDeleteConfirmText(""); setDeletePassword(""); setDeleteTotpCode(""); } }}>
          <div className="sc-meta-dialog w-full max-w-[594px] rounded-2xl border border-edge bg-white p-6 shadow-pop dark:border-[#2a3140] dark:bg-[#1b2029]">
            <h3 className="text-base font-bold text-ink">确认注销账号</h3>
            <p className="mt-2 text-sm text-muted">此操作<strong className="text-up">不可恢复</strong>，将永久删除账号「{user.nickname || user.username}」及全部持仓、订单、分组、偏好等数据。</p>
            <label className="mt-4 block text-xs font-semibold text-muted">请输入登录名「<b className="text-ink">{user.username}</b>」以确认</label>
            <input
              autoFocus
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deleteConfirmText.trim() === user.username) doDeleteAccount(); }}
              placeholder={`请输入 ${user.username}`}
              className="sc-meta-field mt-1.5 w-full border border-edge-strong bg-white px-3 text-sm text-ink outline-none placeholder:opacity-40 focus:border-edge-strong dark:bg-[#151a26] dark:border-[#2a3140]"
            />
            <label className="mt-3 block text-xs font-semibold text-muted">当前密码</label>
            <PasswordInput
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deleteConfirmText.trim() === user.username && deletePassword && (!totpEnabled || deleteTotpCode)) doDeleteAccount(); }}
              autoComplete="current-password"
              placeholder="请输入当前密码"
              className="sc-meta-field mt-1.5 w-full border border-edge-strong bg-white px-3 text-sm text-ink outline-none placeholder:opacity-40 focus:border-edge-strong dark:bg-[#151a26] dark:border-[#2a3140]"
            />
            {totpEnabled && (
              <>
                <label className="mt-3 block text-xs font-semibold text-muted">二次验证码或备用码</label>
                <input
                  value={deleteTotpCode}
                  onChange={(e) => setDeleteTotpCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6 位验证码或备用码"
                  className="sc-meta-field mt-1.5 w-full border border-edge-strong bg-white px-3 text-sm text-ink outline-none placeholder:opacity-40 focus:border-edge-strong dark:bg-[#151a26] dark:border-[#2a3140]"
                />
              </>
            )}
            <div className="mt-5 flex justify-end gap-2.5">
              <button type="button" onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(""); setDeletePassword(""); setDeleteTotpCode(""); }} className="btn btn-ghost btn-sm">取消</button>
              <button type="button" disabled={deleteConfirmText.trim() !== user.username || !deletePassword || (totpEnabled && !deleteTotpCode)} onClick={doDeleteAccount} className="btn btn-ghost btn-sm !text-up disabled:opacity-40">确认注销</button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* 侧栏：搜索 + 分组导航，对齐 Orca 设置语言 */}
      <aside className="sw-sidebar relative hidden w-[248px] flex-none flex-col border-r md:flex">
        <div className="sc-brand"><h1>账户设置</h1></div>
        <div className="sw-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="sw-search-icon" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={sidebarSearchRef}
            value={cmdQuery}
            onChange={(e) => { setCmdQuery(e.target.value); setCmdIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && visibleNavGroups[0]?.items[0]) {
                e.preventDefault();
                jumpTo(visibleNavGroups[0].items[0]);
              }
            }}
            placeholder="搜索设置"
            aria-label="搜索设置"
            className="sw-search-input"
          />
          {cmdQuery === "" ? <span className="sw-search-kbd">⌘K</span> : null}
        </div>
        <div className="sw-sidebar-nav">
        {!cmdQuery.trim() && <nav aria-label="设置分类" className="sc-nav">
          {[{ key: "home", label: "首页", icon: "home" }, ...categories].map((category) => <button type="button" key={category.key} onClick={() => openCategory(category.key)} aria-current={(homeIsBackground ? category.key === "home" : currentCategory?.key === category.key) ? "page" : undefined} className={`sc-nav-link ${(homeIsBackground ? category.key === "home" : currentCategory?.key === category.key) ? "is-active" : ""}`}><SubNavIcon name={category.icon} className="h-5 w-5"/><span>{category.label}</span></button>)}
        </nav>}
        {cmdQuery.trim() && visibleNavGroups.map((g) => (
          <div key={g.label} className="sw-nav-group">
            <p className="sw-nav-group-title">{g.label}</p>
            {g.items.map((item) => (
              <button
                key={item.sub + item.anchor}
                type="button"
                onClick={() => jumpTo(item)}
                className={`sw-nav-item ${sub === item.sub && activeAnchor === item.anchor ? "is-active" : ""}`}
              >
                <SubNavIcon name={SETTINGS_ANCHOR_ICONS[item.anchor] || item.sub} className="h-4 w-4" />
                <span className="truncate">{item.label}</span>
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
        {cmdQuery.trim() && visibleNavGroups.length === 0 ? (
          <p className="sw-search-empty">没有匹配的设置项</p>
        ) : null}
        </div>
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

      {cmdOpen && createPortal(
        <div
          role="dialog"
          aria-label="搜索设置"
          className="sw-cmd-pop sc-command fixed right-4 top-[72px] z-[200] w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-2xl border shadow-pop"
          style={{ borderColor: "rgb(var(--site-edge))", background: "rgb(var(--site-surface))", color: "rgb(var(--site-ink))" }}
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
        </div>, document.body
      )}

      <div className="sw-content flex min-w-0 flex-1 flex-col">
        {/* 内容头部 */}
        <div className="sw-page-head flex flex-none items-center justify-between gap-3">
          <div className="min-w-0">
            {homeIsBackground && <span className="sc-mobile-brand">Alcor</span>}
            {!homeIsBackground && <button type="button" className="sc-back sc-category-back" onClick={() => openCategory(categoryPage ? "home" : detailOrigin || currentCategory?.key || "home")}><span aria-hidden="true">←</span> {categoryPage ? "设置首页" : currentCategory?.label || "设置首页"}</button>}
            <h2>{homeIsBackground ? <><span className="hidden md:inline">首页</span><span className="md:hidden">账户设置</span></> : currentCategory?.label || "账户设置"}</h2>
            <p>{homeIsBackground ? "管理个人信息与账户安全。" : currentCategory?.desc}</p>
          </div>
          <div className="sc-head-actions">
            <button type="button" className="sc-search-button" onClick={openCmdPalette} aria-label="搜索设置"><SubNavIcon name="list"/></button>
          </div>
        </div>

        <div ref={contentScrollRef} className="sw-content-scroll min-h-0 flex-1 overflow-y-auto">
          {categoryPage ? categoryPage === "home" ? homeLanding : <div className="sc-landing">{categoryList}</div> : sub === "passkeys" ? <>
            {detailBackground}
            <PasskeySettings admin={user.role === "admin"} dataSource={passkeyData} mode={activeAnchor === "passkey-config" ? "config" : "keys"} onClose={() => openCategory(detailOrigin || "account")} />
          </> : <>
          {detailBackground}
          <SettingsDetailShell
            title={activeAnchor === "totp"
              ? (totpBackupCodes?.length ? "保存备用码" : totpSetup ? (totpSetupStage === "verify" ? "输入验证码" : totpSetupStage === "name" ? "绑定设备" : "设置说明") : totpEnabled ? "双重验证" : totpLandingStage === "intro" ? "为你的账户加固防护" : "帮助保护你的账户")
              : (activePageMeta?.label || activeSubMeta?.label || "设置")}
            category={currentCategory?.label || "账户设置"}
            detailKey={activeAnchor}
            showBack={activeAnchor === "totp" && (totpEnabled || !!totpSetup || totpLandingStage === "method")}
            closeDisabled={(activeAnchor === "totp" && totpBusy) || (activeAnchor === "profile" && profileSaving) || (activeAnchor === "mobile-nav" && !!blockSaving["mobile-nav"])}
            onBack={activeAnchor === "totp" ? () => {
              if (totpBusy) return;
              if (totpSetup && totpSetupStage === "verify") { setTotpSetupStage("name"); setTotpSetupCode(""); setTotpMsg(null); return; }
              if (totpSetup && totpSetupStage === "name") { setTotpSetupStage("instructions"); setTotpMsg(null); return; }
              if (totpSetup) { setTotpSetup(null); setTotpSetupCode(""); setTotpDeviceName(""); setTotpMsg(null); return; }
              if (!totpEnabled && totpLandingStage === "method") { setTotpLandingStage("intro"); return; }
              openCategory(detailOrigin || currentCategory?.key || "home");
            } : undefined}
            editable={EDITABLE_DETAIL_ANCHORS.has(activeAnchor)}
            editing={activeEditState}
            onEdit={beginActiveEdit}
            onSave={() => { void saveActiveEdit(); }}
            onCancel={cancelActiveEdit}
            onClose={() => { if (activeAnchor === "totp" && !totpEnabled) { setTotpSetup(null); setTotpSetupCode(""); setTotpDeviceName(""); setTotpLandingStage("intro"); setTotpMsg(null); } if (EDITABLE_DETAIL_ANCHORS.has(activeAnchor) && activeEditState) cancelActiveEdit(); openCategory(detailOrigin || currentCategory?.key || "home"); }}
          >
          <SettingsSectionSelection.Provider value={{ active: activeAnchor, anchors: SETTINGS_ANCHORS }}>
          <div key={sub} className="tab-panel sc-detail">
            {!isAdminUser && ADMIN_SUB_KEYS.has(sub) && (
              <div className="rounded-card border border-edge bg-white p-10 text-center shadow-card">
                <p className="text-sm font-semibold text-ink">没有访问权限</p>
                <p className="mt-1 text-xs text-muted">该设置仅管理员可用</p>
              </div>
            )}
            {/* ===== 网站设置 ===== */}
            {sub === "palette" && <PaletteSettings />}
            {sub === "site" && isAdminUser && (
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-5">
                  <SettingsSection
                    icon="info"
                    title="站点信息"
                    desc="网站名称、域名与简介"
                    id="info"
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
                        <SettingsSwitch
                          checked={site.allowRegister}
                          onChange={() => setSite((s) => ({ ...s, allowRegister: !s.allowRegister }))}
                        />
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
                      desc="图标、背景与登录插图"
                      id="appearance"
                    >
                      <div className="brand-settings">
                        <div className="brand-live-preview" style={site.homepageBg ? { backgroundImage: `linear-gradient(135deg, rgba(16,24,32,.72), rgba(16,24,32,.32)), url(${site.homepageBg})` } : undefined}>
                          <div className="brand-preview-browser"><i/><i/><i/><span><img src={site.ico || "/site-icon.svg"} alt="" />{site.title || "Alcor"}</span></div>
                          <div className="brand-preview-body">
                            <div className="brand-preview-logo">{(site.siteLogo || site.ico) ? <img src={site.siteLogo || site.ico} alt="" /> : <span>A</span>}<b>{site.logoText || site.title || "Alcor"}</b></div>
                            <div className="brand-preview-lines"><i/><i/><i/></div>
                            <div className="brand-preview-app"><img src={site.pwaIcon || site.ico || "/site-icon.svg"} alt="" /><span><b>{site.title || "Alcor"}</b><small>主屏幕图标</small></span></div>
                          </div>
                        </div>

                        <div className="sw-row">
                          <div className="sw-row-label"><b>Logo 文字</b></div>
                          <input aria-label="Logo 文字" maxLength={80} readOnly={!editingAppearance} className={`sw-row-input ${editingAppearance ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.logoText} placeholder={site.title || "Alcor"} onChange={e => setSiteField("logoText", e.target.value)} />
                        </div>

                        <section className="brand-settings-group" aria-labelledby="brand-icons-title">
                          <div className="brand-settings-heading"><h3 id="brand-icons-title">应用图标</h3><p>用于浏览器标签、收藏夹和安装到主屏幕后的入口。</p></div>
                          <div className="brand-asset-list">
                        <BrandAssetRow
                          label="网站图标"
                          editable={editingAppearance}
                          desc="浏览器标签与收藏夹"
                          value={site.ico}
                          fallbackValue="/site-icon.svg"
                          emptyLabel="使用默认图标"
                          onChange={(v) => setSiteField("ico", v)}
                          inputRef={icoRef}
                          accept="image/jpeg,image/png,image/gif,image/webp,.ico,.svg"
                          onUpload={(f) => uploadSiteFile("ico", f).then((url) => { if (url) setSiteField("ico", url); })}
                          onClear={() => setSiteField("ico", "")}
                          kind="icon"
                        />
                        <BrandAssetRow
                          label="PWA 图标"
                          editable={editingAppearance}
                          desc="安装后的应用图标"
                          value={site.pwaIcon}
                          fallbackValue={site.ico || "/site-icon.svg"}
                          emptyLabel="自动跟随网站图标"
                          customLabel="使用独立图标"
                          onChange={(v) => setSiteField("pwaIcon", v)}
                          inputRef={pwaIconRef}
                          accept="image/png,image/jpeg,image/webp,.svg,.ico"
                          onUpload={(f) => { void uploadSiteFile("ico", f, "pwaIcon"); }}
                          onClear={() => setSiteField("pwaIcon", "")}
                          kind="icon"
                          busy={pwaUploading}
                          clearLabel="恢复自动"
                        />
                          </div>
                          <p className="brand-settings-note">保存后更新清单；已安装图标由系统更新。</p>
                        </section>

                        <section className="brand-settings-group" aria-labelledby="brand-images-title">
                          <div className="brand-settings-heading"><h3 id="brand-images-title">页面图片</h3><p>控制首页品牌区、页面背景和登录入口的视觉内容。</p></div>
                          <div className="brand-asset-list">
                        <BrandAssetRow
                          label="首页 Logo"
                          editable={editingAppearance}
                          desc="页面左上角标识"
                          value={site.siteLogo}
                          fallbackValue={site.ico || "/site-icon.svg"}
                          emptyLabel="跟随网站图标"
                          onChange={(v) => setSiteField("siteLogo", v)}
                          inputRef={logoRef}
                          accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,.svg"
                          onUpload={(f) => uploadLogo(f).then((url) => { if (url) setSiteField("siteLogo", url); })}
                          onClear={() => setSiteField("siteLogo", "")}
                          kind="logo"
                        />
                        <BrandAssetRow
                          label="网站背景"
                          editable={editingAppearance}
                          desc="主页面背景"
                          value={site.homepageBg}
                          emptyLabel="使用纯色背景"
                          onChange={(v) => setSiteField("homepageBg", v)}
                          inputRef={bgRef}
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          onUpload={(f) => uploadSiteFile("background", f).then((url) => { if (url) setSiteField("homepageBg", url); })}
                          onClear={() => setSiteField("homepageBg", "")}
                          kind="wide"
                        />
                        <BrandAssetRow
                          label="登录页图片"
                          editable={editingAppearance}
                          desc="登录页插图"
                          value={site.loginSideImage}
                          emptyLabel="使用默认插图"
                          onChange={(v) => setSiteField("loginSideImage", v)}
                          inputRef={loginImgRef}
                          accept="image/jpeg,image/png,image/gif,image/webp"
                          onUpload={(f) => uploadLoginImage(f).then((url) => { if (url) setSiteField("loginSideImage", url); })}
                          onClear={() => setSiteField("loginSideImage", "")}
                          kind="wide"
                        />
                          </div>
                        </section>

                        <button type="button" className="brand-reset-all" onClick={() => jumpTo({ sub: "authorizations", anchor: "authorizations", label: "应用授权" })}>授权页设置已移至应用授权 ›</button>

                        {editingAppearance && <button type="button" className="brand-reset-all" disabled={blockSaving.brand || pwaUploading} onClick={() => { void resetBrand(); }}>恢复默认网站形象</button>}
                      </div>
                    </SettingsSection>

                    <SettingsSection
                      icon="stocks"
                      title="首页指数设置"
                      desc="选择指数与轮换间隔"
                      className="xl:col-span-2"
                      id="ticker"
                      titleAction={!editingTicker ? (
                        <button type="button" onClick={() => setEditingTicker(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑首页指数" aria-label="编辑首页指数">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                        </button>
                      ) : undefined}
                      action={editingTicker ? <div className="flex items-center gap-2">{EDIT_CANCEL_BUTTON}<button type="button" onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">保存</button></div> : undefined}
                    >
                      <div className="settings-compact-list mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-[10px] bg-bg-gray/60 px-3 py-2.5 sm:flex sm:flex-wrap sm:gap-3">
                        <span className="text-[13px] font-semibold text-ink-2">轮换间隔</span>
                        <input
                          type="number"
                          min={3}
                          max={60}
                          value={site.ticker.interval}
                          readOnly={!editingTicker}
                          onChange={(e) => setTickerInterval(Number(e.target.value))}
                          className={`col-start-1 row-start-2 h-[34px] w-20 rounded-[8px] px-2.5 text-sm tabular-nums outline-none transition-shadow sm:col-auto sm:row-auto ${editingTicker ? "border border-edge-strong bg-white focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]" : "pointer-events-none border border-transparent bg-transparent"}`}
                        />
                        <span className="col-start-2 row-start-2 text-xs text-muted sm:col-auto sm:row-auto">秒（3 - 60）</span>
                        <span className="col-start-2 row-start-1 text-xs text-faint sm:col-auto sm:row-auto sm:ml-auto">共 {site.ticker.items.length} 个指数</span>
                      </div>

                      <div className="settings-compact-list hidden grid-cols-[auto_auto_minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_auto] items-center gap-2 px-2 pb-1 text-[11px] font-semibold text-faint sm:grid">
                        <span />
                        <span />
                        <span>名称</span>
                        <span>市场</span>
                        <span>东方财富 secid</span>
                        <span />
                      </div>

                      <div className="settings-compact-list settings-meta-list flex flex-col gap-2">
                        {site.ticker.items.map((item, i) => (
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
                            className={editingTicker ? "grid grid-cols-[16px_20px_minmax(0,1fr)_28px] items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 p-2 transition-colors sm:grid-cols-[auto_auto_minmax(0,1.1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)_auto]" : "flex min-h-[50px] min-w-0 items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 px-3 py-2"}
                            title={editingTicker ? "按住拖动排序" : undefined}
                          >
                            {editingTicker && <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 cursor-grab text-faint active:cursor-grabbing">
                              <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
                              <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
                              <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
                            </svg>}
                            <MarketIcon market={item.market} size={20} />
                            {editingTicker ? <>
                            <input
                              value={item.label}
                              onChange={(e) => setTickerItem(i, { label: e.target.value })}
                              placeholder="指数名称"
                              className="h-[34px] min-w-0 rounded-[8px] border border-edge-strong bg-white px-2.5 text-sm font-semibold text-ink outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]"
                            />
                            <div className="col-span-4 row-start-2 grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-2 sm:contents">
                              <input
                                value={item.market}
                                onChange={(e) => setTickerItem(i, { market: e.target.value.trim().toUpperCase() })}
                                placeholder="如 US / HK"
                                list="ticker-market-options"
                                className="h-[34px] min-w-0 rounded-[8px] border border-edge-strong bg-white px-2 text-center text-sm text-ink outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26] sm:text-left"
                              />
                              <input
                                value={item.secid}
                                onChange={(e) => setTickerItem(i, { secid: e.target.value })}
                                placeholder="如 100.DJIA"
                                className="h-[34px] min-w-0 rounded-[8px] border border-edge-strong bg-white px-2.5 font-mono text-xs text-ink outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] dark:bg-[#151a26]"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => removeTickerItem(i)}
                              title="删除指数"
                              className="col-start-4 row-start-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-faint transition-colors hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10 dark:hover:text-white sm:col-auto sm:row-auto"
                            >
                              <DeleteIcon size={14} />
                            </button>
                            </> : <><strong className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={item.label}>{item.label}</strong><span className="w-[84px] min-w-0 flex-none truncate text-right font-mono text-[12px] text-muted" title={`${item.market} · ${item.secid}`}>{item.secid}</span></>}
                          </div>
                        ))}
                      </div>
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
                      desc="拖动排序，启用或隐藏入口"
                      className="xl:col-span-2"
                      id="nav"
                      titleAction={!editingHomeNav ? (
                        <button type="button" onClick={() => setEditingHomeNav(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑首页导航" aria-label="编辑首页导航">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                        </button>
                      ) : undefined}
                      action={editingHomeNav ? <div className="flex items-center gap-2">{EDIT_CANCEL_BUTTON}<button type="button" onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">保存</button></div> : undefined}
                    >
                      <div className="settings-compact-list settings-meta-list flex flex-col gap-2">
                        {(site.homeNav || []).map((item) => (
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
                            className={`group rounded-[12px] border border-edge bg-white transition-[border-color,box-shadow] duration-200 hover:border-edge-strong/50 hover:shadow-[0_4px_14px_rgba(107,114,128,.10)] ${editingHomeNav ? "flex flex-col gap-2 p-3" : "flex min-h-[52px] min-w-0 items-center gap-3 px-3 py-2"}`}
                            title={editingHomeNav ? "按住拖动排序" : undefined}
                          >
                            {editingHomeNav ? <><div className="flex items-center justify-between">
                              <svg viewBox="0 0 24 24" fill="currentColor" className={`h-4 w-4 text-faint ${editingHomeNav ? "cursor-grab active:cursor-grabbing" : "opacity-0"}`}>
                                <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                                <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                                <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                              </svg>
                              <label className="settings-nav-visibility"><span>{item.enabled ? "显示" : "隐藏"}</span><SettingsSwitch checked={item.enabled} onChange={() => setNav(item.key, { enabled: !item.enabled })} label={`${item.enabled ? "隐藏" : "显示"}${item.label}`} /></label>
                            </div>
                            <>
                              <input value={item.label} onChange={(e) => setNav(item.key, { label: e.target.value })} placeholder="名称" className="h-[34px] w-full rounded-[8px] border border-transparent bg-transparent px-2 text-sm font-semibold text-ink outline-none transition-all duration-200 hover:border-edge-strong hover:bg-white focus:border-edge-strong focus:bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)]" />
                              <input value={item.href} onChange={(e) => setNav(item.key, { href: e.target.value })} placeholder="链接，如 #preview / /records" className="h-[32px] w-full rounded-[8px] border border-edge bg-bg-gray/60 px-2.5 font-mono text-[11px] text-muted outline-none transition-all duration-200 hover:border-edge-strong hover:bg-white focus:border-edge-strong focus:bg-white focus:text-ink" />
                            </></> : <><strong className="min-w-0 flex-1 truncate text-sm text-ink">{item.label}</strong><span className="w-[36%] min-w-0 flex-none truncate font-mono text-[13px] text-muted sm:w-[180px]" title={item.href}>{item.href}</span><span className={`settings-item-state ${item.enabled ? "is-on" : ""}`}>{item.enabled ? "已显示" : "已隐藏"}</span></>}
                          </div>
                        ))}
                      </div>
                    </SettingsSection>
                </div>

                <SettingsSection id="mobile-nav" icon="mobile-nav" title="手机导航" desc="前四项显示在底部，其余收进更多。拖动或用箭头调整后自动保存。">
                  {activeAnchor === "mobile-nav" && <MobileNavigationSettings tabs={tabs} order={site.mobileNavigationOrder ?? []} icons={assetIcons} onSave={order => saveBlock("mobile-nav", { mobileNavigationOrder: order }, "已保存")} />}
                  {blockMsg["mobile-nav"]?.type === "err" && <p role="alert" className="settings-form-message is-error">{blockMsg["mobile-nav"]?.text}</p>}
                </SettingsSection>

                <SettingsSection
                  id="app-nav"
                  icon="app-nav"
                  title="应用导航菜单"
                  desc="默认页、入口名称、图标与顺序"
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
                  <div className="settings-compact-list settings-meta-list flex flex-col gap-2">
                    {tabs.map((t, i) => (
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
                        className={editingTabs ? "grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 p-2 transition-colors sm:grid-cols-[auto_auto_minmax(0,1fr)_140px_auto_auto] sm:gap-2.5" : "flex min-h-[50px] min-w-0 items-center gap-2 rounded-[10px] border border-edge bg-bg-gray/30 px-3 py-2"}
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
                        <div className={editingTabs ? "flex min-w-0 items-center gap-2" : "flex min-w-0 flex-1 items-center gap-2"}>
                          <button
                            type="button"
                            disabled={t.key === "trading" || !editingTabs || !!blockSaving[`nav-icon:${t.key}`]}
                            onClick={() => navIconRefs.current[t.key]?.click()}
                            className="group relative flex h-7 w-7 flex-none items-center justify-center overflow-hidden rounded-[9px] border border-edge bg-white shadow-[0_1px_3px_rgba(10,14,25,.08)] disabled:cursor-default dark:bg-[#1c1c1e]"
                            title={t.key === "trading" ? "动态使用专属报纸图标" : `上传/更换「${t.label}」导航图标`}
                          >
                            <SafeAssetImage
                              src={t.key === "trading" ? undefined : assetIcons[t.key.toUpperCase()]}
                              fallback={<span className="flex h-[18px] w-[18px] items-center justify-center text-ink opacity-[.72]">{NAV_ICONS[t.key] ?? null}</span>}
                              className="nav-custom-icon h-full w-full object-contain"
                            />
                            {editingTabs && t.key !== "trading" && <span className="absolute inset-0 flex items-center justify-center rounded-[9px] bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
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
                        <div className={editingTabs ? "col-span-4 flex items-center gap-2 sm:col-span-3 sm:min-w-0" : "flex w-[36%] min-w-0 flex-none items-center gap-2 sm:w-[180px]"}>
                          {editingTabs ? <input
                            value={t.url || `/${t.key}`}
                            onChange={(e) => setTabs((prev) => prev.map((x, idx) => (idx === i ? { ...x, url: e.target.value.trim() } : x)))}
                            placeholder={`/${t.key}`}
                            title="独立 URL，如 /holdings"
                            className="h-[34px] min-w-0 flex-1 rounded-[8px] border border-edge-strong bg-bg-gray/40 px-2.5 font-mono text-xs outline-none transition-shadow focus:bg-white focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)]"
                          /> : <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted" title={t.url || `/${t.key}`}>{t.url || `/${t.key}`}</span>}
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
                </SettingsSection>

              </div>
            )}

            {/* ===== 功能：交易广场 ===== */}
            {sub === "features" && isAdminUser && (
              <div className="flex flex-col gap-6">
                <SettingsSection
                  id="trading-square"
                  icon="features"
                  title="原公开动态来源"
                  desc="保留原公开内容的缓存配置；新的个性化动态在页面右上角编辑指示。"
                  action={editingTradingSquare ? (
                    <button type="button" disabled={blockSaving.tradingSquare} onClick={async () => {
                      const ok = await saveBlock("tradingSquare", {
                        tradingSquareTrumpRefreshMinutes: site.tradingSquareTrumpRefreshMinutes,
                        tradingSquareDuanRefreshMinutes: site.tradingSquareDuanRefreshMinutes
                      }, "公开内容更新频率已保存");
                      if (ok) setEditingTradingSquare(false);
                    }} className="btn btn-line btn-sm disabled:opacity-60">{blockSaving.tradingSquare ? "保存中…" : "保存"}</button>
                  ) : <button type="button" onClick={() => setEditingTradingSquare(true)} className="btn btn-ghost btn-sm">编辑</button>}
                >
                  <div className="flex flex-col">
                    {([
                      ["tradingSquareTrumpRefreshMinutes", "特朗普", "Truth Social 公开动态"],
                      ["tradingSquareDuanRefreshMinutes", "段永平", "雪球公开动态"]
                    ] as const).map(([key, name, desc]) => (
                      <div key={key} className="sw-row settings-inline-row">
                        <div className="sw-row-label"><b>{name}</b><span>{desc}</span></div>
                        <div className="ctrl">
                          {editingTradingSquare ? (
                            <AppSelect className="sw-row-input !w-[150px]" value={site[key]} onChange={(value) => setSite(current => ({ ...current, [key]: Number(value) }))} options={[1, 5, 10, 15, 30, 60, 180, 360, 720, 1440].map((minutes) => ({ value: String(minutes), label: minutes < 60 ? `${minutes} 分钟` : minutes === 60 ? "1 小时" : minutes === 1440 ? "24 小时" : `${minutes / 60} 小时` }))} ariaLabel="更新间隔" />
                          ) : <span className="text-[12.5px] font-semibold text-ink">{site[key] < 60 ? `${site[key]} 分钟` : site[key] === 60 ? "1 小时" : site[key] === 1440 ? "24 小时" : `${site[key] / 60} 小时`}</span>}
                        </div>
                      </div>
                    ))}
                    <div className="sw-row">
                      <div className="sw-row-label"><b>更新方式</b><span>页面始终先读取本地 JSON，不等待外部平台响应</span></div>
                      <div className="ctrl"><span className="inline-flex items-center gap-1.5 text-[12px] text-muted"><i className="h-1.5 w-1.5 rounded-full bg-emerald-500" />缓存优先 · 访问触发</span></div>
                    </div>
                    <div className="sw-row">
                      <div className="sw-row-label"><b>雪球 Cookie</b><span>登录雪球后复制整段 Cookie；服务端带登录会话请求，绕过雪球 WAF 反爬（仅服务端使用）</span></div>
                      <div className="ctrl">
                        <PasswordInput className="sw-row-input" type="password" autoComplete="off" readOnly={!editingTradingSquare}
                          placeholder="xq_a_token=…; u=…; …"
                          value={!site.xueqiuCookie && site.xueqiuCookieConfigured ? "********" : (site.xueqiuCookie || "")}
                          onFocus={(e) => { if (e.currentTarget.value === "********") e.currentTarget.value = ""; }}
                          onChange={(e) => setSite((s) => ({ ...s, xueqiuCookie: e.target.value }))}
                          onBlur={(e) => {
                            const v = e.currentTarget.value.trim();
                            if (!v || v === "********") return;
                            fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ xueqiuCookie: v }) })
                              .then(() => setSite((s) => ({ ...s, xueqiuCookie: v, xueqiuCookieConfigured: true })))
                              .catch(() => {});
                          }}
                        />
                        <span className={`ml-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full align-middle ring-2 ring-white dark:ring-[#151b26] ${site.xueqiuCookieConfigured ? "bg-emerald-500" : "bg-slate-300"}`} title={site.xueqiuCookieConfigured ? "已配置" : "未配置"} />
                      </div>
                    </div>
                  </div>
                  {blockMsg.tradingSquare && <p className={`settings-form-message ${blockMsg.tradingSquare.type === "ok" ? "is-ok" : "is-error"}`}>{blockMsg.tradingSquare.text}</p>}
                </SettingsSection>
              </div>
            )}

            {/* ===== 股票设置：券商管理 ===== */}
            {sub === "stocks" && isAdminUser && (
              <div className="flex flex-col gap-6">
                <SettingsSection
                  icon="tag"
                  title="券商分组"
                  desc="管理持仓券商、别名与顺序。"
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
                  <div className="settings-compact-list settings-meta-list flex flex-col gap-2">
                    {stockGroups.map((g, i) => (
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

                <SettingsSection
                  icon="tag"
                  title="市场色块"
                  desc="统一全站市场徽标的颜色与文字。"
                  id="market-badges"
                  titleAction={!editingMarketBadges ? (
                    <button
                      type="button"
                      onClick={() => setEditingMarketBadges(true)}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink"
                      title="编辑市场色块"
                      aria-label="编辑市场色块"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                      </svg>
                    </button>
                  ) : undefined}
                  action={
                    editingMarketBadges ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSite((s) => ({ ...s, marketBadges: { ...DEFAULT_MARKET_BADGES }, marketBadgesVisible: true }));
                          }}
                          className="btn btn-ghost btn-sm"
                        >
                          恢复默认
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            fetch("/api/settings")
                              .then((res) => (res.ok ? res.json() : null))
                              .then((data) => {
                                setSite((s) => ({
                                  ...s,
                                  marketBadges: normalizeMarketBadges(data?.settings?.marketBadges),
                                  marketBadgesVisible: data?.settings?.marketBadgesVisible !== false
                                }));
                              })
                              .catch(() => undefined);
                            setEditingMarketBadges(false);
                          }}
                          className="btn btn-ghost btn-sm"
                        >
                          取消
                        </button>
                        <button type="button" onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">
                          保存
                        </button>
                      </div>
                    ) : undefined
                  }
                >
                  <div className="sw-row">
                    <div className="sw-row-label">
                      <b>默认显示</b>
                      <span>关闭后全站持仓、搜索、分享页不再展示市场色块</span>
                    </div>
                    <SettingsSwitch
                      checked={site.marketBadgesVisible !== false}
                      onChange={() => {
                        const next = site.marketBadgesVisible === false;
                        setSite((current) => ({ ...current, marketBadgesVisible: next }));
                        applyMarketBadges(site.marketBadges, next);
                      }}
                    />
                  </div>
                  <div className="settings-meta-list flex flex-col gap-2">
                    {MARKET_BADGE_ITEMS.map((item) => {
                      const badge = normalizeMarketBadges(site.marketBadges)[item.key];
                      return (
                        <div key={item.key} className="flex flex-wrap items-center gap-2.5 rounded-[14px] border border-edge bg-white p-3 dark:bg-[#151a26]">
                          <span
                            className="inline-flex h-[22px] min-w-[36px] flex-none items-center justify-center rounded-[4px] px-1.5 text-[11px] font-bold leading-none"
                            style={{ backgroundColor: badge.bg, color: badge.fg }}
                          >
                            {badge.label || item.key}
                          </span>
                          <strong className="min-w-[88px] flex-none text-sm font-semibold text-ink">{item.name}</strong>
                          {editingMarketBadges ? (
                            <>
                              <input
                                value={badge.label}
                                onChange={(e) => setSite((s) => ({
                                  ...s,
                                  marketBadges: {
                                    ...normalizeMarketBadges(s.marketBadges),
                                    [item.key]: { ...badge, label: e.target.value.slice(0, 4) }
                                  }
                                }))}
                                className="h-[34px] w-[72px] rounded-[8px] border border-edge bg-bg-gray/40 px-2 text-center text-xs font-bold outline-none focus:border-edge-strong focus:bg-white dark:focus:bg-[#151a26]"
                                maxLength={4}
                                aria-label={`${item.name}文字`}
                              />
                              <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                                底色
                                <span className="h-5 w-5 rounded-md border border-edge" style={{ backgroundColor: badge.bg }} />
                                <input
                                  type="text"
                                  value={badge.bg}
                                  onChange={(e) => setSite((s) => ({
                                    ...s,
                                    marketBadges: {
                                      ...normalizeMarketBadges(s.marketBadges),
                                      [item.key]: { ...badge, bg: e.target.value }
                                    }
                                  }))}
                                  className="h-8 w-[78px] rounded-lg border border-edge bg-bg-gray px-2 font-mono text-[11px] text-ink outline-none focus:border-edge-strong"
                                  aria-label={`${item.name}底色`}
                                />
                              </label>
                              <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                                文字
                                <span className="h-5 w-5 rounded-md border border-edge" style={{ backgroundColor: badge.fg }} />
                                <input
                                  type="text"
                                  value={badge.fg}
                                  onChange={(e) => setSite((s) => ({
                                    ...s,
                                    marketBadges: {
                                      ...normalizeMarketBadges(s.marketBadges),
                                      [item.key]: { ...badge, fg: e.target.value }
                                    }
                                  }))}
                                  className="h-8 w-[78px] rounded-lg border border-edge bg-bg-gray px-2 font-mono text-[11px] text-ink outline-none focus:border-edge-strong"
                                  aria-label={`${item.name}文字色`}
                                />
                              </label>
                            </>
                          ) : (
                            <span className="text-xs text-muted">{badge.bg.toUpperCase()}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {editingMarketBadges && (
                    <button
                      type="button"
                      onClick={() => setSite((s) => ({ ...s, marketBadges: { ...DEFAULT_MARKET_BADGES }, marketBadgesVisible: true }))}
                      className="btn btn-ghost btn-sm mt-3 self-start"
                    >
                      恢复默认
                    </button>
                  )}
                  {blockMsg.marketBadges && (
                    <p className={`mt-3 rounded-[10px] px-3.5 py-2.5 text-[13px] ${blockMsg.marketBadges.type === "ok" ? "bg-brand-light text-brand-deep" : "bg-up-bg text-up"}`}>
                      {blockMsg.marketBadges.text}
                    </p>
                  )}
                </SettingsSection>

                {(() => {
                  const legacyProvider = normalizedModelProvider(site.llmProvider);
                  const services: ModelServiceConfig[] = site.modelServices.length ? site.modelServices : [{
                    id: "legacy-primary",
                    name: legacyProvider === "deepseek" ? "DeepSeek" : legacyProvider === "openai" ? "OpenAI" : "自定义服务",
                    provider: legacyProvider,
                    icon: "",
                    apiUrl: site.llmApiUrl,
                    apiKey: site.llmApiKey,
                    apiKeyConfigured: site.llmApiKeyConfigured,
                    models: [site.llmModel || "deepseek-chat"]
                  }];
                  const updateServices = (next: ModelServiceConfig[]) => setSite(current => ({ ...current, modelServices: next }));
                  const updateService = (id: string, patch: Partial<ModelServiceConfig>) => {
                    setModelTestStates(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${id}:`))));
                    updateServices(services.map(item => item.id === id ? { ...item, ...patch } : item));
                  };
                  const reorderServices = (from: number, to: number) => {
                    if (to < 0 || to >= services.length || from === to) return;
                    const next = [...services];
                    const [item] = next.splice(from, 1);
                    next.splice(to, 0, item);
                    updateServices(next);
                    if (editingModel) return;
                    void saveBlock("model-order", { modelServices: next }, "模型优先级已保存").then(ok => { if (!ok) updateServices(services); });
                  };
                  const addService = () => {
                    const id = `model-service-${Date.now().toString(36)}`;
                    updateServices([...services, {
                    id,
                    name: "新模型服务",
                    provider: "custom",
                    icon: "",
                    apiUrl: "",
                    apiKey: "",
                    models: [""]
                    }]);
                    const url = new URL(window.location.href);
                    url.searchParams.set("panel", `models:${id}`);
                    window.history.pushState(null, "", url);
                  };
                  return (
                    <SettingsSection
                      id="translation"
                      icon="model"
                      title="模型服务"
                      desc="管理聊天与决策模型。聊天模型按顺序回退。"
                      className="settings-model-section"
                      action={editingModel ? <div className="flex items-center gap-2">{EDIT_CANCEL_BUTTON}<button type="button" disabled={!!uploadingModelIconId || !!blockSaving.model} onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">{uploadingModelIconId ? "图标保存中…" : "保存"}</button></div> : <button type="button" onClick={() => { if (!site.modelServices.length) updateServices(services); setEditingModel(true); }} className="btn btn-ghost btn-sm">编辑</button>}
                    >
                      <div className="model-service-stack">
                        <SettingsManagedGroup scope="models" inline={services.length === 1} headings={false} editing={editingModel} onReorder={blockSaving["model-order"] ? undefined : reorderServices}>
                        {services.map((service, serviceIndex) => {
                          const meta = MODEL_PROVIDERS.find(item => item.id === service.provider) || MODEL_PROVIDERS[3];
                          const configured = Boolean(service.apiKey || service.apiKeyConfigured) && Boolean(service.apiUrl) && service.models.some(Boolean);
                          const connected = configured && service.models.filter(Boolean).every(model => modelTestStates[`${service.id}:${model}`]?.state === "ok");
                          return (
                            <SettingsManagedPane key={service.id} name={service.id} title={service.name || "未命名服务"} summary={`${configured ? "已配置" : "待完善"} · ${service.models.filter(Boolean).join(" → ") || "尚未添加模型"} · 优先级 ${serviceIndex + 1}`}>
                            <article
                              key={service.id}
                              className={`model-service-panel ${!editingModel && services.length > 1 && !blockSaving["model-order"] ? "is-draggable" : ""}`}
                              draggable={!editingModel && services.length > 1 && !blockSaving["model-order"]}
                              onDragStart={event => { modelDragIndexRef.current = serviceIndex; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", service.id); }}
                              onDragOver={event => { if (!editingModel) event.preventDefault(); }}
                              onDrop={() => { if (!editingModel && modelDragIndexRef.current !== null) reorderServices(modelDragIndexRef.current, serviceIndex); modelDragIndexRef.current = null; }}
                            >
                              <div className="model-service-summary">
                                <div className="flex min-w-0 items-center gap-3">
                                  {!editingModel && services.length > 1 && <span className="model-service-drag" title="拖动调整优先级" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>}
                                  <ModelProviderIcon provider={service.provider} icon={service.icon} />
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <strong className="model-service-name">{service.name || "未命名服务"}</strong>
                                      <span className={`model-service-status ${connected ? "is-ready" : "is-disconnected"}`} title={connected ? "所有模型连接测试成功" : configured ? "已配置，但尚未全部通过连接测试" : "配置未完成"}><i />{configured ? "已配置" : "待完善"}</span>
                                    </div>
                                    <p className="truncate">{service.models.filter(Boolean).join(" → ") || "尚未添加模型"} · {meta.hint}</p>
                                  </div>
                                </div>
                                {!editingModel ? <span className="model-service-use">{service.provider === "jev" ? "决策专用" : blockSaving["model-order"] ? "保存排序…" : `优先级 ${serviceIndex + 1}`}</span> : (
                                  <div className="model-order-actions">
                                    <button type="button" onClick={() => reorderServices(serviceIndex, serviceIndex - 1)} disabled={serviceIndex === 0 || !!blockSaving["model-order"]} aria-label="服务上移">↑</button>
                                    <button type="button" onClick={() => reorderServices(serviceIndex, serviceIndex + 1)} disabled={serviceIndex === services.length - 1 || !!blockSaving["model-order"]} aria-label="服务下移">↓</button>
                                    <button type="button" className="is-danger" onClick={() => updateServices(services.filter(item => item.id !== service.id))} disabled={services.length === 1} aria-label="删除服务"><DeleteIcon className="h-4 w-4" /></button>
                                  </div>
                                )}
                              </div>

                              {editingModel ? (
                                <div className="model-service-editor">
                                  <div className="model-provider-grid">
                                    {MODEL_PROVIDERS.map(item => (
                                      <button key={item.id} type="button" disabled={!!uploadingModelIconId} onClick={() => updateService(service.id, { provider: item.id, name: service.name === "新模型服务" || MODEL_PROVIDERS.some(candidate => candidate.name === service.name) ? item.name : service.name, apiUrl: item.url || service.apiUrl, icon: service.icons?.[item.id] || "", apiKey: item.id === service.provider ? service.apiKey : "", apiKeyConfigured: item.id === service.provider ? service.apiKeyConfigured : false, models: item.id === "jev" && service.provider !== "jev" ? ["jev-latest"] : service.provider === "jev" && item.id !== "jev" ? [""] : service.models })} className={`model-provider-option ${service.provider === item.id ? "is-active" : ""}`}>
                                        <ModelProviderIcon provider={item.id} icon={service.icons?.[item.id] || ""} className="h-8 w-8" />
                                        <span><b>{item.name}</b><small>{item.hint}</small></span><i className="model-provider-check" />
                                      </button>
                                    ))}
                                  </div>
                                  <div className="model-identity-row">
                                    <label className="model-field"><span>服务名称<small>会显示在上方服务列表</small></span><input className="sw-row-input" value={service.name} maxLength={50} onChange={event => updateService(service.id, { name: event.target.value })} placeholder="例如：公司代理服务" /></label>
                                    <div className="model-icon-controls">
                                      <label className="model-icon-upload">
                                        <input type="file" disabled={!!uploadingModelIconId} accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={async event => {
                                          const input = event.currentTarget;
                                          const file = input.files?.[0];
                                          if (!file || uploadingModelIconId) return;
                                          setUploadingModelIconId(service.id);
                                          try {
                                            const settings = await uploadModelIcon(file, service.name, service.id, services);
                                            setSite(current => ({ ...current, ...settings, llmApiKey: current.llmApiKey }));
                                            captureSaved(settings);
                                            showToast("模型服务图标已保存");
                                          } catch (error) {
                                            showToast(error instanceof Error ? error.message : "图标上传失败", "err");
                                          } finally {
                                            input.value = "";
                                            setUploadingModelIconId(null);
                                          }
                                        }} />
                                        <ModelProviderIcon provider={service.provider} icon={service.icon} className="h-9 w-9" />
                                        <span>{uploadingModelIconId === service.id ? "保存中…" : service.icon ? "更换图标" : "上传图标"}</span>
                                      </label>
                                      {service.icon && <button type="button" onClick={() => updateService(service.id, { icon: "", icons: { ...service.icons, [service.provider]: "" } })}>恢复默认</button>}
                                    </div>
                                  </div>
                                  <label className="model-field"><span>API 地址<small>{service.provider === "jev" ? "TypeSafe System One 决策接口" : "OpenAI 兼容的 Chat Completions 地址"}</small></span><input className="sw-row-input" value={service.apiUrl} onChange={event => updateService(service.id, { apiUrl: event.target.value })} placeholder={service.provider === "jev" ? "https://api.typesafe.ai/v1/systemone" : "https://api.example.com/v1/chat/completions"} autoComplete="off" /></label>
                                  <label className="model-field"><span>API 密钥<small>留空不会覆盖已保存密钥</small></span><div className="relative min-w-0 flex-1"><PasswordInput className="sw-row-input !w-full pr-24" type="password" autoComplete="new-password" value={service.apiKey} onChange={event => updateService(service.id, { apiKey: event.target.value })} placeholder={service.apiKeyConfigured ? "已配置，输入新值可替换" : "输入 API Key"} /><span className={`model-key-state ${service.apiKey || service.apiKeyConfigured ? "is-ready" : ""}`}><i />{service.apiKey || service.apiKeyConfigured ? "已保护" : "未配置"}</span></div></label>
                                  <div>
                                    <div className="model-list-heading"><span>{service.provider === "jev" ? "决策模型" : "模型与回退顺序"}<small>{service.provider === "jev" ? "测试连接使用结构化判断请求；不参与聊天与翻译回退" : "从上到下依次尝试"}</small></span><button type="button" onClick={() => updateService(service.id, { models: [...service.models, ""] })}><b>＋</b> 添加模型</button></div>
                                    <div className="model-list">
                                      {service.models.map((model, modelIndex) => (
                                        <div className="model-row" key={`${service.id}-${modelIndex}`}>
                                          <span className="model-priority">{modelIndex + 1}</span>
                                          <input className="sw-row-input" value={model} maxLength={160} onChange={event => updateService(service.id, { models: service.models.map((item, index) => index === modelIndex ? event.target.value : item) })} placeholder={service.provider === "jev" ? "jev-latest" : "模型 ID"} />
                                          <button type="button" className={`model-test-button is-${modelTestStates[`${service.id}:${model}`]?.state || "idle"}`} onClick={() => { void testModelService(service, model); }} disabled={!model || modelTestStates[`${service.id}:${model}`]?.state === "loading"} title={modelTestStates[`${service.id}:${model}`]?.state === "ok" ? `连接成功，耗时 ${modelTestStates[`${service.id}:${model}`].text}；点击重新测试` : modelTestStates[`${service.id}:${model}`]?.text || "测试模型连接"}>{modelTestStates[`${service.id}:${model}`]?.state === "loading" ? "…" : modelTestStates[`${service.id}:${model}`]?.state === "ok" ? <><span aria-hidden="true">✓</span><span>{modelTestStates[`${service.id}:${model}`].text}</span></> : modelTestStates[`${service.id}:${model}`]?.state === "error" ? "重试" : "测试"}</button>
                                          <button type="button" onClick={() => { const next=[...service.models]; const [item]=next.splice(modelIndex,1); next.splice(modelIndex-1,0,item); updateService(service.id,{models:next}); }} disabled={modelIndex === 0} aria-label="模型上移">↑</button>
                                          <button type="button" onClick={() => { const next=[...service.models]; const [item]=next.splice(modelIndex,1); next.splice(modelIndex+1,0,item); updateService(service.id,{models:next}); }} disabled={modelIndex === service.models.length - 1} aria-label="模型下移">↓</button>
                                          <button type="button" onClick={() => updateService(service.id, { models: service.models.filter((_, index) => index !== modelIndex) })} disabled={service.models.length === 1} aria-label="删除模型"><DeleteIcon className="h-4 w-4" /></button>
                                          {modelTestStates[`${service.id}:${model}`]?.state === "error" && <span className="model-test-result is-error">{modelTestStates[`${service.id}:${model}`].text}</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div className="model-service-readonly">
                                  <div><span>API 地址</span><b title={service.apiUrl}>{service.apiUrl || "未设置"}</b></div>
                                  {service.models.filter(Boolean).map(model => <div key={model} className="model-readonly-test-row"><span className="model-readonly-test-copy"><b title={model}>{model}</b>{modelTestStates[`${service.id}:${model}`]?.text && <small className={modelTestStates[`${service.id}:${model}`]?.state === "error" ? "text-up" : "text-muted"}>{modelTestStates[`${service.id}:${model}`].text}</small>}</span><button type="button" className="btn btn-line btn-sm" onClick={() => void testModelService(service, model)} disabled={modelTestStates[`${service.id}:${model}`]?.state === "loading"}>{modelTestStates[`${service.id}:${model}`]?.state === "loading" ? "测试中…" : modelTestStates[`${service.id}:${model}`]?.state === "ok" ? "重新测试" : "测试连接"}</button></div>)}
                                  <div><span>密钥</span><b>{service.apiKeyConfigured || service.apiKey ? "已安全保存" : "未配置"}</b></div>
                                </div>
                              )}
                            </article>
                            </SettingsManagedPane>
                          );
                        })}
                        </SettingsManagedGroup>
                        {editingModel && <button type="button" className="model-add-service" onClick={addService}><b>＋</b><span>添加模型服务<small>接入聊天或决策模型</small></span></button>}
                        <div className="model-privacy-note"><SubNavIcon name="key" className="h-4 w-4" /><span>API 密钥只保存在服务端。聊天模型按顺序回退；Jev 仅用于结构化决策配置与连接测试。</span></div>
                      </div>
                    </SettingsSection>
                  );
                })()}

                {/* 交易：富途 OpenAPI 连接配置 + 行情源切换（两块分开，不揉在一起） */}
                <SettingsSection
                  icon="trade"
                  title="交易 · 富途 / 行情源"
                  desc="管理 OpenD 连接与行情来源。"
                  id="trade"
                  titleAction={!editingFutu ? (
                    <button type="button" onClick={() => setEditingFutu(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑富途连接" aria-label="编辑富途连接">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingFutu ? <div className="flex items-center gap-2">{EDIT_CANCEL_BUTTON}<button type="button" onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">保存</button></div> : undefined}
                >
                  <SettingsManagedGroup scope="trade" inline editing={editingFutu}>
                    <SettingsManagedPane name="connection" title="OpenD 连接" summary={`${site.futuHost || "127.0.0.1"}:${site.futuPort || "11111"} · ${futuOnline === null ? "检测中…" : futuOnline ? "已连接" : futuSkipped ? "本地跳过" : "未连接"}`}>
                      <div className={`sw-row ${editingFutu ? "" : "settings-inline-row"}`}>
                        <div className="sw-row-label"><b>OpenD 主机</b><span>填写运行 OpenD 的设备地址</span></div>
                        <input className={`sw-row-input ${editingFutu ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.futuHost} readOnly={!editingFutu} onChange={(e) => setSiteField("futuHost", e.target.value)} placeholder="127.0.0.1" />
                      </div>
                      <div className="sw-row settings-inline-row settings-port-row">
                        <div className="sw-row-label"><b>端口</b></div>
                        <input className={`sw-row-input ${editingFutu ? "" : "pointer-events-none !border-transparent !bg-transparent !shadow-none"}`} value={site.futuPort} readOnly={!editingFutu} onChange={(e) => setSiteField("futuPort", e.target.value)} placeholder="11111" inputMode="numeric" />
                      </div>
                    <div className="sw-row settings-inline-row">
                      <div className="sw-row-label"><b>连接状态</b>{futuSkipped && <span title="本地开发服务默认不连接 OpenD；如需启用，设置 STOCKLOG_FUTU=on 后重启。">本地默认跳过，测试仍会连接</span>}</div>
                      <div className="ctrl">
                        <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${futuOnline === null ? "text-faint" : futuOnline ? "text-[#0fa07b]" : "text-[#e5a13b]"}`}>
                          <i className={`h-1.5 w-1.5 rounded-full ${futuOnline === null ? "bg-[#d1d5db]" : futuOnline ? "bg-[#0fa07b]" : "bg-[#e5a13b]"}`} />
                          {futuOnline === null ? "检测中…" : futuOnline ? "已连接" : futuSkipped ? "本地跳过" : "未连接"}
                        </span>
                        <button type="button" disabled={futuTest?.busy} onClick={testFutu} className="btn btn-line btn-sm disabled:opacity-60">
                          {futuTest?.busy ? "测试中…" : "测试连接"}
                        </button>
                        {futuTest?.msg && (
                          <span className={`text-[11px] ${futuTest.ok ? "text-[#0fa07b]" : "text-up"}`}>{futuTest.msg}</span>
                        )}
                      </div>
                    </div>
                    </SettingsManagedPane>
                    <SettingsManagedPane name="quota" title="接口额度" heading={false} summary={futuQuota.data?.subscription && futuQuota.data.historyKl ? `订阅 ${futuQuota.data.subscription.ownUsed}/${futuQuota.data.subscription.ownTotalQuota} · 历史K线 ${futuQuota.data.historyKl.used}/${futuQuota.data.historyKl.totalQuota}` : "按需查询，不自动消耗接口额度"}>
                    <div className="sw-row">
                      <div className="sw-row-label"><b>接口额度</b><span>已用 / 总额</span></div>
                      <div className="ctrl flex flex-nowrap items-center gap-2">
                        {futuQuota.data?.subscription && futuQuota.data.historyKl ? (
                          <span className="settings-futu-quota" title={futuQuota.at ? `查询于 ${new Date(futuQuota.at).toLocaleString("zh-CN", { hour12:false })}` : undefined}>
                            <span>
                              订阅 <b className="text-ink">{futuQuota.data.subscription.ownUsed}</b> / {futuQuota.data.subscription.ownTotalQuota}
                            </span>
                            <span>
                              历史K线 <b className="text-ink">{futuQuota.data.historyKl.used}</b> / {futuQuota.data.historyKl.totalQuota}
                            </span>
                          </span>
                        ) : futuQuota.loading ? (
                          <span className="text-[11.5px] text-faint">查询中…</span>
                        ) : (
                          <span className="text-[11.5px] text-faint">{futuQuota.ok === false ? "查询失败，请重试" : "未查询"}</span>
                        )}
                        <button type="button" disabled={futuQuota.loading} onClick={() => void loadFutuQuota()} className="btn btn-line btn-sm disabled:opacity-60">
                          {futuQuota.loading ? "查询中…" : "查询额度"}
                        </button>
                      </div>
                    </div>
                    </SettingsManagedPane>
                    <SettingsManagedPane name="source" title="行情来源" heading={false} summary={site.quoteSource === "futu" ? "仅富途" : site.quoteSource === "tencent" ? "腾讯 + Yahoo" : "自动（富途优先）"}>
                    <div className="sw-row settings-inline-row">
                      <div className="sw-row-label"><b>行情来源</b><span>自动模式失败时使用备用源</span></div>
                      {editingFutu ? <AppSelect value={site.quoteSource} onChange={value => setSite(s => ({ ...s, quoteSource:value as SiteSettings["quoteSource"] }))} options={[{value:"auto",label:"自动（富途优先）"},{value:"futu",label:"仅富途"},{value:"tencent",label:"腾讯 + Yahoo"}]} className="settings-clean-select" ariaLabel="行情来源" /> : <span className="settings-detail-value">{site.quoteSource === "futu" ? "仅富途" : site.quoteSource === "tencent" ? "腾讯 + Yahoo" : "自动（富途优先）"}</span>}
                    </div>
                    </SettingsManagedPane>
                  </SettingsManagedGroup>
                </SettingsSection>
                <SettingsSection id="currency-display" icon="stocks" title="货币金额显示" desc="大额金额显示方式">
                  <div className="sw-row">
                    <div className="sw-row-label">
                      <b>金额单位</b>
                      <span>同一页面统一启用智能缩写，再按数值选用万、亿或万亿</span>
                    </div>
                    <div className="ctrl">
                      <AppSelect value={currencyDisplayUnit} onChange={(value) => setCurrencyDisplayUnit(value as CurrencyDisplayUnit)} options={[{ value: "auto", label: "按页面智能缩写（推荐）" }, { value: "compact", label: "所有页面智能缩写" }, { value: "full", label: "始终完整" }]} className="sw-row-input" ariaLabel="货币金额显示单位" />
                    </div>
                  </div>
                </SettingsSection>

                <SettingsSection
                  icon={SOURCE_SECTIONS.find((section) => section.id === activeAnchor)?.icon || "plug"}
                  title={SOURCE_SECTIONS.find((section) => section.id === activeAnchor)?.title || "行情与汇率接口"}
                  desc={SOURCE_SECTIONS.find((section) => section.id === activeAnchor)?.desc || "实时行情、搜索、分时走势与汇率换算"}
                  id={SOURCE_DETAIL_ANCHORS.has(activeAnchor) ? activeAnchor : "sources"}
                  titleAction={!editingSources ? (
                    <button type="button" onClick={() => setEditingSources(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑股票来源接口" aria-label="编辑股票来源接口">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingSources ? <div className="flex items-center gap-2">{EDIT_CANCEL_BUTTON}<button type="button" onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">保存</button></div> : undefined}
                >
                  <div className="source-field-list flex flex-col">
                    {SOURCE_SECTIONS.filter((section) => section.id === activeAnchor).map(({ id, keys }) => {
                      const fields = SOURCE_FIELDS.filter((f) => (keys as readonly string[]).includes(f.key));
                      if (!fields.length) return null;
                      return (
                        <Fragment key={id}>
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
                        </Fragment>
                      );
                    })}
                  </div>
                </SettingsSection>
              </div>
            )}

            {/* ===== 个人信息 ===== */}
            {sub === "profile" && (
              <div className="flex flex-col gap-6">
                <SettingsSection
                  id="profile"
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
                      <div className="sw-row settings-inline-row">
                        <div className="sw-row-label"><b>用户名<span className="ml-0.5" style={{ display: "inline" }}>*</span></b><span>唯一标识，不可修改</span></div>
                        <div className="ctrl" style={{ flex: 1 }}><code className="settings-code-value">{me.username}</code></div>
                      </div>
                      <div className={`sw-row ${editingProfile ? "" : "settings-inline-row"}`}>
                        <div className="sw-row-label"><b>昵称</b><span>最多 20 个字符</span></div>
                        <div className="ctrl" style={{ flex: 1 }}>
                          {editingProfile ? (
                            <input ref={nickInputRef} disabled={profileSaving} maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} className="sw-row-input" />
                          ) : (
                            <span className="settings-profile-value" title={nickname}>{nickname || "未设置昵称"}</span>
                          )}
                        </div>
                      </div>
                      <div className="sw-row">
                        <div className="sw-row-label"><b>登录邮箱<span className="ml-0.5" style={{ display: "inline" }}>*</span></b><span>{me.emailVerified?"已验证，可用于找回密码":"验证后可用于找回密码"}</span></div>
                        <div className="ctrl" style={{ flex: 1 }}>
                          {editingProfile ? (
                            <input ref={emailInputRef} disabled={profileSaving} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="sw-row-input" />
                          ) : (
                            <span className="settings-profile-value" title={email}>{email || "未设置邮箱"}</span>
                          )}
                        </div>
                      </div>
                      {!editingProfile && me.email && !me.emailVerified && <div className="sw-row"><div className="sw-row-label"><b>验证邮箱</b><span>点击确认邮件中的链接</span></div><button type="button" disabled={emailVerifyBusy} onClick={()=>void sendEmailConfirmation()} className="btn btn-line btn-sm">{emailVerifyBusy?"发送中…":"发送确认邮件"}</button></div>}
                      {emailVerifyMessage && <p role={emailVerifyState === "error" ? "alert" : "status"} className={`settings-form-message is-${emailVerifyState}`}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/>{emailVerifyState === "error" ? <path d="M12 7v6m0 3h.01"/> : <path d="m8 12 3 3 5-6"/>}</svg><span>{emailVerifyMessage}</span></p>}
                      {editingProfile && email.trim().toLowerCase() !== (me.email ?? "").trim().toLowerCase() && (
                        <div className="sw-row">
                          <div className="sw-row-label"><b>安全验证</b><span>修改登录邮箱需要当前密码</span></div>
                          <div className="ctrl" style={{ flex: 1 }}><PasswordInput type="password" disabled={profileSaving} value={profilePassword} onChange={(e) => setProfilePassword(e.target.value)} autoComplete="current-password" placeholder="当前密码" className="sw-row-input" /></div>
                        </div>
                      )}
                      {nickMsg && <p className={`settings-form-message ${nickMsg.type === "ok" ? "is-ok" : "is-error"}`}>{nickMsg.text}</p>}
                    </div>
                  </div>
                </SettingsSection>
                <SettingsSection id="password" icon="password" title="更改密码">
                  <form onSubmit={changePassword} className="settings-password-grid settings-password-meta">
                    <div className="settings-account-identity"><span className="settings-account-avatar">{me.avatar ? <img src={me.avatar} alt="" /> : (me.nickname || me.username).slice(0, 1)}</span><span><b>{me.nickname || me.username}</b><small>{me.email || `@${me.username}`}</small></span><span aria-hidden="true">›</span></div>
                    <label><span>当前密码</span><PasswordInput type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required autoFocus data-autofocus autoComplete="current-password" placeholder="当前密码" /></label>
                    <div><label><span>新密码</span><PasswordInput type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required maxLength={128} autoComplete="new-password" placeholder="新密码" /></label><PasswordStrength password={newPassword} userInputs={[me.username, me.nickname, me.email ?? ""]} /></div>
                    <label><span>确认新密码</span><PasswordInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required maxLength={128} autoComplete="new-password" placeholder="再次输入新密码" /></label>
                    {totpEnabled && (
                      <label><span>二次验证码</span><input autoComplete="one-time-code" spellCheck={false} value={totpPasswordCode} onChange={(e) => setTotpPasswordCode(e.target.value)} required placeholder="验证器 6 位数字或备用码" /></label>
                    )}
                    <button type="button" className="settings-password-forgot" onClick={openPasswordRecovery}>忘记密码了？</button>
                    <button type="submit" disabled={pwdBusy} className="settings-meta-primary">{pwdBusy ? "提交中…" : "更改密码"}</button>
                    <label className="settings-signout-option"><input type="checkbox" checked={signOutOtherDevices} onChange={(event) => setSignOutOtherDevices(event.target.checked)} /><span>在其他设备上退出登录。如果有人使用了你的账户，请选择此项。</span></label>
                  </form>
                  {pwdMsg && <p className={`settings-form-message ${pwdMsg.type === "ok" ? "is-ok" : "is-error"}`}>{pwdMsg.text}</p>}
                </SettingsSection>
                <SettingsSection id="data" icon="data" title="导入与导出" desc="备份或迁移你的数据">
                  <div className="settings-profile-actions">
                  <SettingsManagedGroup scope="data" inline headings={false}>
                  <SettingsManagedPane name="export" title="导出网站数据" summary="备份持仓、订单、分组与个人设置">
                  <p className="settings-managed-note">包含持仓、订单、自选分组、个人偏好与昵称；不含图片、图标和数据库连接信息。管理员导出另含站点设置与名人持仓。</p>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>网站数据</b><span>下载为 JSON 文件</span></div>
                    <div className="ctrl">
                      <button type="button" disabled={backupBusy === "export"} onClick={exportSiteBackup} className="btn btn-ghost btn-sm disabled:opacity-60">{backupBusy === "export" ? "导出中…" : "导出"}</button>
                    </div>
                  </div>
                  </SettingsManagedPane>
                  <SettingsManagedPane name="import" title="导入网站数据" summary="从 Alcor 备份文件恢复数据">
                  <p className="settings-managed-note">选择 Alcor 导出的 JSON 文件，确认内容后导入。请先导出现有数据留作备份。</p>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>备份文件</b><span>JSON 格式</span></div>
                    <div className="ctrl">
                      <button type="button" disabled={backupBusy === "import"} onClick={() => importBackupRef.current?.click()} className="btn btn-ghost btn-sm disabled:opacity-60">{backupBusy === "import" ? "导入中…" : "导入"}</button>
                      <input ref={importBackupRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importSiteBackup(f); }} />
                    </div>
                  </div>
                  </SettingsManagedPane>
                  <SettingsManagedPane name="holdings" title="持仓数据" summary={`导出持仓与自选记录 · ${recordsCount} 条`}>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>持仓数据</b><span>导出持仓与自选记录，共 {recordsCount} 条</span></div>
                    <button type="button" onClick={onExport} className="btn btn-ghost btn-sm">导出</button>
                  </div>
                  </SettingsManagedPane>
                  </SettingsManagedGroup>
                  </div>
                </SettingsSection>
                <SettingsSection id="danger" icon="danger" title="清空投资数据" desc="删除持仓、自选与相关投资记录；操作不可恢复">
                  <div className="settings-danger-zone">
                  <div className="sw-row">
                    <div className="sw-row-label"><b>清空数据</b><span>不可恢复，请谨慎操作</span></div>
                    <button type="button" onClick={clearAll} disabled={clearing || recordsCount === 0} className="btn btn-ghost btn-sm !text-up disabled:opacity-50">{clearing ? "清空中…" : "清空"}</button>
                  </div>
                  </div>
                </SettingsSection>
                <SettingsSection id="delete-account" icon="delete-account" title="注销账号" desc="永久删除本账号、登录方式及全部个人数据">
                  <div className="settings-danger-zone">
                    <div className="sw-row">
                      <div className="sw-row-label"><b>永久注销</b><span>账号删除后不可恢复，请先导出备份</span></div>
                      <button type="button" onClick={() => setShowDeleteConfirm(true)} className="btn btn-ghost btn-sm !text-up">注销账号</button>
                    </div>
                  </div>
                </SettingsSection>
              </div>
            )}

            {sub === "authorizations" && <AppAuthorizationSettings site={site} admin={isAdminUser} onSave={(fields, signal) => saveBlock("app-connection", fields, "连接配置已保存", signal)} />}

            {sub === "totp" && (
              <div id="totp" className="flex flex-col gap-6">
                <section className="totp-meta-flow">
                  {!totpStatusLoaded && <div className="totp-meta-loading" aria-label="正在读取双重验证状态"><i /><i /><i /></div>}
                  {totpStatusLoaded && !totpEnabled && !totpSetup && !totpBackupCodes?.length && (
                    totpLandingStage === "intro" ? <div className="totp-meta-intro">
                      <p className="totp-meta-copy">为登录添加额外验证，确认是你本人操作。</p>
                      <ul className="totp-meta-benefits">
                        <li><SubNavIcon name="account"/><span>即使密码泄露，一次性验证码也能帮助保护账户。</span></li>
                        <li><SubNavIcon name="totp"/><span>通过身份验证应用获取验证码，无需短信。</span></li>
                        <li><SubNavIcon name="data"/><span>保存备用码，设备丢失后仍可恢复登录。</span></li>
                      </ul>
                      <button type="button" className="totp-meta-primary" onClick={() => setTotpLandingStage("method")}>开始</button>
                    </div> :
                    <>
                      <p className="totp-meta-copy">设置双重验证后，登录时除密码外还需要一次性验证码，确认是你本人。</p>
                      <button type="button" className="totp-meta-learn" onClick={(event) => { const scroll = event.currentTarget.closest(".sc-detail-dialog-scroll"); setTotpLearnMore((value) => !value); requestAnimationFrame(() => scroll?.scrollTo({ top: 0 })); }}>详细了解</button>
                      {totpLearnMore && <p className="totp-meta-help">验证码由身份验证应用在本机生成，无需短信。请同时保存备用码，以便设备丢失时恢复登录。</p>}
                      <h3>选择你希望接收验证码的方式</h3>
                      <div className="totp-meta-methods" aria-label="双重验证方式">
                        <button type="button" className="totp-meta-method is-selected" disabled={totpBusy} onClick={() => void startTotpSetup()}>
                          <span className="totp-meta-method-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M15 14h2v2h-2zM19 14h1v3h-3v3h-3v-2M19 19h1v1h-1z"/></svg></span>
                          <span className="totp-meta-method-copy"><b>身份验证应用</b><small>通过 Google Authenticator、1Password、Bitwarden 等应用获取一次性验证码。</small><em>推荐</em></span>
                          <span className="totp-meta-radio" aria-hidden="true" />
                        </button>
                        <div className="totp-meta-method is-unavailable" aria-disabled="true">
                          <span className="totp-meta-method-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5.5h16v11H9l-4 3v-3H4z"/><path d="M8 9h8M8 12.5h5"/></svg></span>
                          <span className="totp-meta-method-copy"><b>短信</b><small>Alcor 暂未提供短信验证码。</small></span>
                          <span className="totp-meta-radio" aria-hidden="true" />
                        </div>
                      </div>
                      <button type="button" disabled={totpBusy} onClick={startTotpSetup} className="totp-meta-primary">{totpBusy ? "请稍候…" : "继续"}</button>
                    </>
                  )}
                  {totpSetup && (
                    <div className="totp-meta-setup">
                      {totpSetupStage === "instructions" ? <>
                        <div className="totp-meta-step"><h3>1. 下载身份验证应用</h3><p>如果你还未安装身份验证应用，建议使用 Google Authenticator、1Password 或 Bitwarden。</p></div>
                        <div className="totp-meta-step"><h3>2. 扫描二维码或复制密钥</h3><p>请在身份验证应用中扫描二维码，或者复制密钥并粘贴到应用中。</p></div>
                        <div className="totp-meta-setup-grid">
                          <div className="totp-meta-qr">{totpSetup.qrPng && <img alt="二次验证二维码" src={totpSetup.qrPng} />}</div>
                          <div className="totp-meta-secret"><code>{totpSetup.secret.replace(/(.{4})/g, "$1 ").trim()}</code><div><button type="button" onClick={() => void copySecurityText(totpSetup.secret, "密钥")}>复制密钥</button>{totpSetup.otpauthUrl && <button type="button" onClick={() => void copySecurityText(totpSetup.otpauthUrl, "链接")}>复制链接</button>}</div></div>
                        </div>
                        <div className="totp-meta-step"><h3>3. 复制并输入 6 位数验证码</h3><p>扫描二维码或输入密钥后，身份验证应用将生成一组 6 位数验证码。</p></div>
                        <button type="button" className="totp-meta-primary totp-meta-next" onClick={() => setTotpSetupStage("name")}>输入验证码</button>
                      </> : totpSetupStage === "name" ? <>
                        <p className="totp-meta-copy">请为身份验证应用命名，便于以后识别。</p>
                        <form className="totp-meta-name-form" onSubmit={(event) => { event.preventDefault(); if (totpDeviceName.trim()) { setTotpSetupStage("verify"); setTotpSetupCode(""); setTotpMsg(null); } }}>
                          <label><span>名称</span><input autoFocus autoComplete="off" value={totpDeviceName} onChange={(event) => setTotpDeviceName(event.target.value)} placeholder="例如：iPhone 上的验证器" maxLength={64} required /></label>
                          <button type="submit" className="totp-meta-primary" disabled={!totpDeviceName.trim()}>下一页</button>
                        </form>
                      </> : <>
                        <p className="totp-meta-copy">输入身份验证应用中显示的 6 位数验证码。</p>
                        <form onSubmit={confirmTotpSetup} className="totp-meta-code-form">
                          <label><span>验证码</span><input autoComplete="one-time-code" autoFocus spellCheck={false} inputMode="numeric" maxLength={6} value={totpSetupCode} onChange={(e) => setTotpSetupCode(normalizeTotpDigits(e.target.value))} placeholder="6 位数字" required /></label>
                          <button type="submit" className="totp-meta-primary" disabled={totpBusy || !isSixDigitTotp(totpSetupCode)}>{totpBusy ? "验证中…" : totpReauthNeeded ? "验证并继续" : "继续"}</button>
                        </form>
                      </>}
                    </div>
                  )}
                  {totpBackupCodes && totpBackupCodes.length > 0 && (
                    <div className="totp-meta-backup">
                      <p className="totp-meta-copy">备用码只显示这一次。验证器不可用时，每个备用码可代替验证码使用一次。</p>
                      <ul>{totpBackupCodes.map((code) => <li key={code}>{code}</li>)}</ul>
                      <div className="totp-meta-backup-actions"><button type="button" onClick={() => void copySecurityText(totpBackupCodes.join("\n"), "备用码")}>复制</button><button type="button" onClick={downloadBackupCodes}>下载</button></div>
                      <button type="button" className="totp-meta-primary" onClick={() => setTotpBackupCodes(null)}>我已保存</button>
                    </div>
                  )}
                  {totpStatusLoaded && totpEnabled && !totpBackupCodes?.length && (
                    <div className="totp-meta-enabled">
                      <div className="totp-meta-methods"><div className="totp-meta-method is-selected"><span className="totp-meta-method-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M15 14h2v2h-2zM19 14h1v3h-3v3h-3v-2M19 19h1v1h-1z"/></svg></span><span className="totp-meta-method-copy"><b>{totpDeviceName || "身份验证应用"}</b><small>已开启，可使用验证码或备用码登录。</small></span><span className="totp-meta-status">已开启</span></div></div>
                      <h3>关闭双重验证</h3>
                      <form onSubmit={disableTotp} className="totp-meta-disable">
                        <label><span>当前密码</span><PasswordInput type="password" autoComplete="current-password" value={totpDisablePassword} onChange={(e) => setTotpDisablePassword(e.target.value)} required /></label>
                        <label><span>验证码或备用码</span><input autoComplete="one-time-code" value={totpDisableCode} onChange={(e) => setTotpDisableCode(e.target.value)} required /></label>
                        <button type="submit" disabled={totpBusy}>{totpBusy ? "提交中…" : "关闭双重验证"}</button>
                      </form>
                    </div>
                  )}
                  {totpMsg && <p className={`settings-form-message ${totpMsg.type === "ok" ? "is-ok" : "is-error"}`}>{totpMsg.text}</p>}
                </section>
              </div>
            )}

            {/* ===== 数据库增强 ===== */}
            {sub === "database" && isAdminUser && (
              <div id="database" className="flex flex-col gap-6">
                {/* 类型选择 */}
                <SettingsSection
                  icon="database"
                  title="数据库"
                  desc="选择本地或远程存储。"
                  titleAction={!editingDb ? (
                    <button type="button" onClick={() => setEditingDb(true)} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-brand-hover hover:text-ink" title="编辑数据库" aria-label="编辑数据库">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                    </button>
                  ) : undefined}
                  action={editingDb ? <div className="flex items-center gap-2">{EDIT_CANCEL_BUTTON}<button type="button" onClick={() => { void saveActiveEdit(); }} className="btn btn-line btn-sm">保存</button></div> : undefined}
                >
                  <SettingsManagedGroup scope="database" inline headings={false} editing={editingDb}>
                  <SettingsManagedPane name="type" title="存储方式" summary={site.dbType === "sqlite" ? "SQLite · 本地文件" : "PostgreSQL · 远程数据库"}>
                  <div className="subhead">数据库类型</div>
                  <div className="settings-db-types">
                    {([
                      { type: "sqlite" as const, title: "SQLite", desc: "本地文件，无需配置" },
                      { type: "postgres" as const, title: "PostgreSQL", desc: "远程数据库，适合多人使用" }
                    ]).map((opt) => (
                      <button
                        key={opt.type}
                        type="button"
                        disabled={!editingDb}
                        onClick={() => setSite({ ...site, dbType: opt.type })}
                        aria-pressed={site.dbType === opt.type}
                        className={`settings-db-type ${site.dbType === opt.type ? "is-selected" : ""}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-ink">{opt.title}</span>
                          <span className={`settings-choice-radio ${site.dbType === opt.type ? "is-selected" : ""}`}>
                            {site.dbType === opt.type && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3"><path d="m5 13 4 4L19 7" /></svg>
                            )}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted">{opt.desc}</p>
                      </button>
                    ))}
                  </div>

                  </SettingsManagedPane>
                  <SettingsManagedPane name="connection" title={site.dbType === "sqlite" ? "数据库状态" : "连接配置"} summary={site.dbType === "sqlite" ? dbStatus ? `${(dbStatus.sizeBytes / 1024).toFixed(1)} KB · ${dbStatus.tables.length} 张表` : dbStatusError || "读取中…" : `${site.pgHost || "未设置主机"}:${site.pgPort || "5432"}`}>
                {/* SQLite 信息 */}
                {site.dbType === "sqlite" && (
                  <>
                    <div className="subhead">SQLite 状态</div>
                    {dbStatus ? (
                      <div className="settings-db-status-list">
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
                        <details className="settings-db-tables"><summary>数据表<span>{dbStatus.tables.length} 张</span></summary><p>{dbStatus.tables.join("、")}</p></details>
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
                        <PasswordInput type="password" value={site.pgPassword} readOnly={!editingDb} onChange={(e) => setSite({ ...site, pgPassword: e.target.value })} placeholder="数据库密码" className={`h-[42px] rounded-[10px] border border-edge-strong px-3 outline-none transition-shadow focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.14)] ${editingDb ? "" : "!border-transparent !bg-transparent !shadow-none"}`} />
                      </label>
                    </div>
                    {dbMsg && (
                      <p className={`rounded-[10px] px-3.5 py-2.5 text-[13px] break-all ${dbMsg.type === "ok" ? "bg-bg-gray text-ink" : "bg-up-bg text-up"}`}>
                        {dbMsg.text}
                      </p>
                    )}
                    <div className="mt-4 flex flex-wrap gap-3">
                      <button type="button" disabled={dbTesting} onClick={testDb} className="btn btn-ghost btn-sm disabled:opacity-60">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" />
                        </svg>
                        {dbTesting ? "测试中…" : "测试连接"}
                      </button>
                    </div>
                  </>
                )}
                  </SettingsManagedPane>
                  </SettingsManagedGroup>
                </SettingsSection>
              </div>
            )}

            {/* ===== 定时任务 ===== */}
            {sub === "cron" && isAdminUser && (
              <div className="flex flex-col gap-6">
                <SettingsSection id="mail" icon="api" title="邮件服务" desc="用于找回密码。测试邮件收到后再保存。">
                  <div className="mail-settings">
                    <fieldset className="mail-settings-fields" disabled={mailTesting || blockSaving.mail}>
                    <div className="mail-settings-group">
                      <div className="mail-settings-group-title"><b>服务器</b><span>由你的邮件服务商提供</span></div>
                      <div className="mail-settings-server-grid">
                        <label><span>SMTP 主机</span><input type="text" value={site.smtpHost} onChange={(event) => setSite({ ...site, smtpHost: event.target.value })} placeholder="smtp.example.com" autoComplete="off" /></label>
                        <label><span>端口</span><input type="text" inputMode="numeric" value={site.smtpPort} onChange={(event) => setSite({ ...site, smtpPort: event.target.value.replace(/\D/g, "").slice(0, 5) })} placeholder="587" /></label>
                      </div>
                      <div className="mail-settings-two-col">
                        <label><span>用户名</span><input type="text" value={site.smtpUser} onChange={(event) => setSite({ ...site, smtpUser: event.target.value })} autoComplete="username" placeholder="name@example.com" /></label>
                        <label><span>授权码</span><PasswordInput type="password" value={site.smtpPassword} onChange={(event) => setSite({ ...site, smtpPassword: event.target.value })} autoComplete="new-password" placeholder={site.smtpPasswordConfigured ? "已保存 · 留空不修改" : "输入邮箱授权码"} /></label>
                      </div>
                      <button type="button" role="switch" aria-checked={site.smtpSecure} onClick={() => setSite({ ...site, smtpSecure: !site.smtpSecure })} className="mail-settings-switch-row">
                        <span><b>直接使用 SSL/TLS</b><small>465 端口通常开启；587 端口通常关闭</small></span>
                        <i className={site.smtpSecure ? "is-on" : ""} aria-hidden="true"><em style={{ backgroundColor: "#fff" }} /></i>
                      </button>
                    </div>
                    <div className="mail-settings-group">
                      <div className="mail-settings-group-title"><b>发件人</b><span>显示在密码重置邮件中</span></div>
                      <div className="mail-settings-sender-grid">
                        <label><span>名称</span><input type="text" value={site.smtpFromName} onChange={(event) => setSite({ ...site, smtpFromName: event.target.value })} placeholder="Alcor" /></label>
                        <label><span>邮箱</span><input type="email" value={site.smtpFromEmail} onChange={(event) => setSite({ ...site, smtpFromEmail: event.target.value })} placeholder="no-reply@example.com" /></label>
                      </div>
                    </div>
                    <div className="mail-settings-group">
                      <div className="mail-settings-group-title"><b>验证链接</b><span>收件人点击后访问的地址</span></div>
                      <label><span>网站 HTTPS 地址</span><input type="url" value={site.emailLinkOrigin} onChange={(event) => setSite({ ...site, emailLinkOrigin: event.target.value })} placeholder="https://fire.example.com" autoComplete="url" /></label>
                      <p className="mail-settings-link-note">留空沿用站点域名{site.domain ? `（${site.domain}）` : ""}。内网 IP 不会用于验证邮件；请填写收件人能访问的公网 HTTPS 域名。测试邮件仅检查 SMTP。</p>
                    </div>
                    </fieldset>
                    {mailResult && <p className={`settings-form-feedback is-${mailResult.type}`} role={mailResult.type === "err" ? "alert" : "status"}><svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><g stroke="#fff">{mailResult.type === "ok" ? <path d="m7.5 12 3 3 6-6" /> : <><path d="M12 7v6" /><circle cx="12" cy="16.5" r="1" fill="#fff" stroke="none" /></>}</g></svg><span>{mailResult.text}</span></p>}
                    <div className="mail-settings-actions">
                      <button type="button" disabled={mailTesting || blockSaving.mail} onClick={() => void testMailSettings()} className="mail-settings-test">{mailTesting ? "发送中…" : "发送测试邮件"}</button>
                      <button type="button" disabled={blockSaving.mail || mailTesting} onClick={() => void saveBlock("mail", { smtpHost: site.smtpHost, smtpPort: site.smtpPort, smtpSecure: site.smtpSecure, smtpUser: site.smtpUser, smtpPassword: site.smtpPassword, smtpFromName: site.smtpFromName, smtpFromEmail: site.smtpFromEmail, emailLinkOrigin: site.emailLinkOrigin }, "邮件服务已保存")} className="mail-settings-save">{blockSaving.mail ? "保存中…" : "保存"}</button>
                    </div>
                  </div>
                </SettingsSection>
                <SettingsSection id="cron" icon="cron" title="定时任务" desc="查看刷新与缓存规则。汇率仅手动刷新。">
                <div className="settings-task-list">
                  {[
                    {
                      key: "rates",
                      icon: "money",
                      name: "汇率",
                      desc: "仅手动请求，不消耗定时额度",
                      schedule: "不自动请求",
                      state: "手动",
                      action: true
                    },
                    {
                      key: "earnings",
                      icon: "cal",
                      name: "财报日历",
                      desc: "美股、A股与港股财报",
                      schedule: "缓存 30 分钟",
                      state: "已启用"
                    },
                    {
                      key: "topstocks",
                      icon: "chart",
                      name: "全球市值榜",
                      desc: "日股、韩股与全球榜缓存 6 小时",
                      schedule: "30 分钟 / 6 小时",
                      state: "已启用"
                    },
                    {
                      key: "kline",
                      icon: "wave",
                      name: "月 K 走势",
                      desc: "复用月 K 走势数据",
                      schedule: "10 分钟",
                      state: "已启用"
                    },
                    {
                      key: "quotes",
                      icon: "search",
                      name: "实时行情",
                      desc: "后端页面实时行情",
                      schedule: "每 60 秒",
                      state: "已启用"
                    },
                    {
                      key: "board",
                      icon: "plug",
                      name: "行情板",
                      desc: "在行情板中设置刷新间隔",
                      schedule: "1 秒至 1 日",
                      state: "可配置"
                    }
                  ].map((task) => (
                    <div key={task.key} className="settings-task-row">
                      <div className="min-w-0 flex-1">
                        <strong className="settings-task-name">{task.name}</strong>
                        <p className="mt-0.5 text-xs text-muted">{task.desc}</p>
                      </div>
                      <span className="settings-task-schedule">{task.schedule}</span>
                      {task.action && <CronRefreshButton />}
                    </div>
                  ))}
                </div>
                </SettingsSection>
                <SettingsSection id="backups" icon="backups" title="自动备份" desc="定期备份数据与素材，清理旧备份。">
                  <div className="settings-task-list"><BackupTaskCard /></div>
                </SettingsSection>
              </div>
            )}

            {/* ===== API 开发接口 ===== */}
            {sub === "api" && (
              <div id="api" className="flex flex-col gap-6">
                <SettingsSection
                  icon="api"
                  title="API 开发接口"
                  desc="接口鉴权、版本与访问策略"
                >
                  <div className="sw-row">
                    <div className="sw-row-label"><b>鉴权方式</b><span>登录态与程序化访问</span></div>
                    <span className="settings-detail-value api-auth-methods"><b>Session Cookie</b><i aria-hidden="true" />Bearer Token</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>接口版本</b><span>稳定版基础路径</span></div>
                    <code className="settings-code-value">/api/v1</code>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>访问保护</b><span>限制异常频率并保留错误语义</span></div>
                    <span className="settings-status-badge is-on"><i />已启用</span>
                  </div>
                  <a href="/api-docs" target="_blank" rel="noreferrer" className="sw-row api-docs-entry-row" aria-label="在新窗口打开 API 文档">
                    <span className="sw-row-label"><b>API 文档</b><span>认证、参数与请求示例</span></span>
                    <span className="api-docs-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M19 14v5H5V5h5" /></svg></span>
                  </a>
                </SettingsSection>
              </div>
            )}

            {/* ===== 关于 ===== */}
            {sub === "about" && (
              <div id="about" className="flex flex-col gap-6">
                <SettingsSection icon="info" title="关于" desc="版本、技术栈与外部数据源">
                  <button type="button" onClick={() => setVersionOpen(true)} className="sw-row settings-navigation-row" aria-label="查看版本记录">
                    <span className="sw-row-label"><b>当前版本</b><span>Alcor {CURRENT_VERSION.version} · {CURRENT_VERSION.changes.length} 项更新</span></span>
                    <svg className="settings-navigation-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                  </button>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>前端技术栈</b><span>交互与响应式界面</span></div>
                    <span className="settings-detail-value">Next.js 15 · React 19 · TypeScript · Tailwind CSS · WebGL 原图动效 · KTX2/UASTC 纹理压缩 · zxcvbn-ts（本地密码强度）</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>数据与服务</b><span>本地优先，可切换企业数据库</span></div>
                    <span className="settings-detail-value">Node.js · SQLite · PostgreSQL · ExcelJS · saxes（SVG / RSS 校验）· SimpleWebAuthn（通行密钥）</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>部署运行</b><span>容器镜像与受限更新</span></div>
                    <span className="settings-detail-value">Docker · GHCR · Watchtower</span>
                  </div>
                  <div className="sw-row">
                    <div className="sw-row-label"><b>外部数据源</b><span>行情、财报、汇率与公开披露</span></div>
                    <span className="settings-detail-value">腾讯行情 · 东方财富 · 雪球 · SEC EDGAR · CompaniesMarketCap · Google News RSS · Brave Search（可选）</span>
                  </div>
                </SettingsSection>
              </div>
            )}
          </div>
          </SettingsSectionSelection.Provider>
          </SettingsDetailShell>
          </>}
        </div>
      </div>
      {versionOpen && <VersionModal onClose={() => setVersionOpen(false)} />}
      {passwordRecoveryOpen && <AppModal title="找回密码" desc="通过已绑定邮箱设置新密码" onClose={() => { if (!passwordRecoveryBusy) setPasswordRecoveryOpen(false); }} closeDisabled={passwordRecoveryBusy}>
        <EmailRecoveryForm initialLogin={me.username} fixedLogin hideTitle emailAvailable={me.emailVerified} totpAvailable={totpEnabled} onBusy={setPasswordRecoveryBusy} />
      </AppModal>}
    </div>
  );
}
