"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { showToast } from "@/lib/toast";
import { cardTagsOf } from "@/lib/cardTags";
import CurrencyFlag from "@/components/CurrencyFlag";
import CardWalletStack, { type WalletCard, type WalletCardDetails } from "@/components/CardWalletStack";
import { FALLBACK_RATES } from "@/lib/types";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { readCachedRates, writeCachedRates } from "@/lib/ratesCache";
import { CARD_CURRENCIES, REGION_CURRENCY, currencySymbol } from "@/lib/cardCurrencies";
import {
  CURRENCY_SCOPE_LABEL,
  CURRENCY_SCOPE_ORDER,
  cardCurrencyScope,
  currencyScopeSummary,
  isCurrencyScope,
  type CurrencyScope,
  type CurrencyScopeInfo
} from "@/lib/cardCurrency";
import type { CardLibraryPayload } from "@/lib/cardLibrary";
import type { CardDetails } from "@/lib/cardWallet";

interface CardItem {
  name: string;
  type: string;
  file: string;
  sourceType?: string;
  brand?: string;
  level?: string;
  bins?: number[];
  /** 原图字节数（脚本抓取时写入） */
  bytes?: number;
}

interface BankEntry {
  name: string;
  englishName: string;
  country: string;
  folder: string;
  cards: CardItem[];
}

interface RegionEntry {
  label: string;
  banks: BankEntry[];
}

interface CardAmount {
  cardKey: string;
  amount: number;
  currency: string;
  note: string;
  updatedAt: string;
}

interface CardEntry {
  card: CardItem;
  bank: BankEntry;
  region: string;
  tags: string[];
}

const ALL = "全部";
const PAGE_SIZE = 60;
/** 聚焦反馈：全站同款中性灰柔光（去掉浏览器默认蓝框后仍能看出焦点在哪） */
const FOCUS_RING =
  "focus:border-edge-strong focus:shadow-[0_0_0_3px_rgba(107,114,128,.15)] focus:outline-none dark:focus:border-white/20 dark:focus:shadow-[0_0_0_3px_rgba(255,255,255,.10)]";
/** 常用标签建议（可自由输入，这里只是快捷入口） */
const TAG_SUGGESTIONS = ["虚拟卡", "实体卡", "金属卡", "透明卡", "收藏", "主力卡", "已注销", "纪念版"];

/**
 * 卡片「金额」的含义按类型分档：借记卡 / 预付卡填的是**余额**（真钱，计入资产分析的现金），
 * 信用卡填的是**额度**（可透支上限，不是钱）。两者不能加在一起 —— 额度合计与银行卡现金
 * 对不上就是这个原因，所以总览里分开显示。
 */
const CASH_AMOUNT_TYPES = new Set(["借记卡", "预付卡"]);
type AmountGroup = "balance" | "limit" | "other";
function amountGroupOf(type: string): AmountGroup {
  if (CASH_AMOUNT_TYPES.has(type)) return "balance";
  if (type === "信用卡") return "limit";
  return "other";
}

/** 地区按洲分组（下拉里用 optgroup 展示）；洲内把中国各地排最前，再按卡面数量排 */
const CONTINENT_ORDER = ["亚洲", "欧洲", "北美洲", "大洋洲", "其他"] as const;
const REGION_CONTINENT: Record<string, string> = {
  中国内地: "亚洲",
  中国香港: "亚洲",
  中国澳门: "亚洲",
  中国台湾: "亚洲",
  日本: "亚洲",
  新加坡: "亚洲",
  哈萨克斯坦: "亚洲",
  英国: "欧洲",
  德国: "欧洲",
  爱尔兰: "欧洲",
  俄罗斯: "欧洲",
  美国: "北美洲",
  加拿大: "北美洲",
  澳大利亚: "大洋洲"
};
const CHINA_REGIONS = new Set(["中国内地", "中国香港", "中国澳门", "中国台湾"]);
/** 地区 → ISO 二字码（取素材库里的国旗） */
const REGION_ISO: Record<string, string> = {
  中国内地: "CN",
  中国香港: "HK",
  中国澳门: "MO",
  中国台湾: "TW",
  日本: "JP",
  新加坡: "SG",
  哈萨克斯坦: "KZ",
  英国: "GB",
  德国: "DE",
  爱尔兰: "IE",
  俄罗斯: "RU",
  美国: "US",
  加拿大: "CA",
  澳大利亚: "AU"
};

function fmtAmount(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function fmtBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileExt(file: string): string {
  return (file.split(".").pop() || "").toUpperCase();
}

function Pill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full border px-4 py-2 text-[13px] font-semibold transition-all duration-200 ${
        active
          ? "border-[#111] bg-[#111] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#111]"
          : "border-edge bg-white text-ink-2 hover:border-edge-strong hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

/** 币种范围角标配色：单币中性、双币蓝、多币种紫、待确认琥珀 */
const SCOPE_CHIP_CLASS: Record<CurrencyScope, string> = {
  single: "bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white/70",
  dual: "bg-[#3297f6]/12 text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]",
  multi: "bg-[#8b5cf6]/14 text-[#7c3aed] dark:bg-[#8b5cf6]/22 dark:text-[#c4b5fd]",
  unknown: "bg-[#f59e0b]/16 text-[#b45309] dark:bg-[#f59e0b]/20 dark:text-[#fcd34d]"
};

/** 多选胶囊组：数值为空 = 全部；点「全部」清空选择 */
function PillGroup({
  label,
  options,
  values,
  onToggle,
  onClear
}: {
  label: string;
  options: { key: string; count?: number }[];
  values: string[];
  onToggle: (key: string) => void;
  onClear: () => void;
}) {
  const all = options[0];
  const allActive = values.length === 0;
  return (
    <div className="flex w-max min-w-0 items-center gap-2 sm:w-auto sm:flex-wrap">
      <span className="mr-0.5 text-[11px] font-semibold text-faint">{label}</span>
      {all && (
        <Pill active={allActive} onClick={onClear}>
          {all.key}
          {all.count !== undefined && <span className={`ml-1.5 ${allActive ? "text-white/60 dark:text-[#111]/50" : "text-faint"}`}>{all.count}</span>}
        </Pill>
      )}
      {options.slice(1).map((option) => {
        const active = values.includes(option.key);
        return (
          <Pill key={option.key} active={active} onClick={() => onToggle(option.key)}>
            {option.key}
            {option.count !== undefined && (
              <span className={`ml-1.5 ${active ? "text-white/60 dark:text-[#111]/50" : "text-faint"}`}>{option.count}</span>
            )}
          </Pill>
        );
      })}
    </div>
  );
}

/** 多选下拉：按钮显示已选摘要，面板里逐项勾选（支持分组标题与计数） */
function MultiSelect({
  label,
  allLabel,
  options,
  values,
  onChange,
  renderIcon
}: {
  label: string;
  allLabel: string;
  options: { value: string; label: string; group?: string; icon?: React.ReactNode }[];
  values: string[];
  onChange: (next: string[]) => void;
  /** 摘要按钮里显示的图标（按已选值取），用于地区国旗这类标识 */
  renderIcon?: (value: string) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  const iconOf = (value: string) => options.find((option) => option.value === value)?.icon ?? null;
  const summary = values.length === 0 ? allLabel : values.length === 1 ? labelOf(values[0]) : `${labelOf(values[0])} +${values.length - 1}`;
  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  };
  /** Esc 关掉面板（手机抽屉与桌面小面板都适用） */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  let currentGroup: string | undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-muted">{label}</span>
      <span className="relative block">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          title={summary}
          aria-expanded={open}
          className={`flex h-11 w-full items-center justify-between gap-2 rounded-xl border bg-white px-3 text-left text-sm font-semibold text-ink transition-all duration-200 hover:border-edge-strong sm:h-10 dark:bg-[#1c222d] dark:text-white ${
            open ? "border-edge-strong shadow-[0_0_0_3px_rgba(107,114,128,.15)]" : "border-edge"
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {values.length === 1 ? (renderIcon ? renderIcon(values[0]) : iconOf(values[0])) : null}
            <span className="min-w-0 truncate">{summary}</span>
          </span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 flex-none text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
            <path d="m5 7 5 5 5-5" />
          </svg>
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-[1px] sm:bg-transparent sm:backdrop-blur-none" onClick={() => setOpen(false)} />
            {/* 手机：从底部升起的抽屉（占满宽、行高够点）；≥sm 回到按钮下面的小面板 */}
            <div className="thin-scrollbar fixed inset-x-0 bottom-0 z-[70] max-h-[72vh] space-y-1 overflow-y-auto overscroll-contain rounded-t-2xl border-t border-edge-strong bg-white px-1 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-pop dark:border-white/10 dark:bg-[#1b2029] sm:absolute sm:inset-x-auto sm:z-40 sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:max-h-[320px] sm:w-full sm:min-w-[220px] sm:rounded-xl sm:border sm:pb-1">
              <span className="mx-auto mt-2 block h-1 w-10 rounded-full bg-edge-strong sm:hidden" />
              <span className="flex items-center justify-between gap-2 px-3 py-1.5 sm:hidden">
                <b className="text-[13px] font-bold text-ink dark:text-white">{label}</b>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-full px-2 py-1 text-[12px] font-semibold text-[#2f6fed]"
                >
                  完成
                </button>
              </span>
              <button
                type="button"
                onClick={() => onChange([])}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-[13px] font-semibold transition-colors sm:py-2 sm:text-xs ${
                  values.length === 0 ? "bg-bg-gray text-ink dark:bg-white/10" : "text-muted hover:bg-brand-hover hover:text-ink dark:hover:bg-white/10"
                }`}
              >
                {allLabel}
                {values.length === 0 && (
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                    <path d="m2.4 6.4 2.5 2.5 4.7-5.8" />
                  </svg>
                )}
              </button>
              {options.map((option) => {
                const header = option.group && option.group !== currentGroup ? option.group : null;
                currentGroup = option.group ?? currentGroup;
                const active = values.includes(option.value);
                return (
                  <span key={option.value} className="block">
                    {header && <span className="mt-1 block px-3 pb-1 pt-2.5 text-[11px] font-semibold text-faint sm:pt-2 sm:text-[10px]">{header}</span>}
                    <button
                      type="button"
                      onClick={() => toggle(option.value)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-3 text-left text-[13px] transition-colors sm:py-1.5 sm:text-xs ${
                        active ? "bg-[#3297f6]/12 font-semibold text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]" : "text-ink hover:bg-brand-hover dark:text-white/80 dark:hover:bg-white/10"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {option.icon}
                        <span className="min-w-0 truncate">{option.label}</span>
                      </span>
                      {active && (
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 flex-none">
                          <path d="m2.4 6.4 2.5 2.5 4.7-5.8" />
                        </svg>
                      )}
                    </button>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </span>
    </div>
  );
}

export default function CardLibraryView({ initial = null }: { initial?: CardLibraryPayload | null }) {
  // 首帧直接用服务端注入的清单与个人数据（无注入时才回落到骨架屏 + 客户端请求）
  const [regions, setRegions] = useState<RegionEntry[]>(() => (initial?.regions as RegionEntry[] | undefined) ?? []);
  const [typeOrder, setTypeOrder] = useState<string[]>(() => initial?.typeOrder ?? []);
  const [amounts, setAmounts] = useState<Record<string, CardAmount>>(() => {
    const map: Record<string, CardAmount> = {};
    (initial?.amounts ?? []).forEach((item) => {
      if (item?.cardKey) map[item.cardKey] = item;
    });
    return map;
  });
  const [holdings, setHoldings] = useState<Record<string, boolean>>(() => {
    const held: Record<string, boolean> = {};
    (initial?.holdings ?? []).forEach((key) => {
      if (key) held[key] = true;
    });
    return held;
  });
  /** mine = 我的卡（默认）；all = 全量卡面库，用来挑卡加入 */
  const [mode, setMode] = useState<"mine" | "all">("mine");
  const [updatedAt, setUpdatedAt] = useState<string | null>(() => initial?.updatedAt ?? null);
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(!initial);

  // 各维度都是多选：空数组 = 全部；同一维度内 OR，跨维度 AND
  const [region, setRegion] = useState<string[]>([]);
  /** 类型筛选：单选（空 = 全部类型），和币种一样 */
  const [type, setType] = useState("");
  const [bankFolder, setBankFolder] = useState<string[]>([]);
  const [brand, setBrand] = useState<string[]>([]);
  const [level, setLevel] = useState<string[]>([]);
  const [tag, setTag] = useState<string[]>([]);
  const [myTag, setMyTag] = useState<string[]>([]);
  /** 币种范围筛选：单选（值是 CURRENCY_SCOPE_LABEL 里的中文，空 = 全部） */
  const [scopeFilter, setScopeFilter] = useState("");
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [active, setActive] = useState<CardEntry | null>(null);
  const [draft, setDraft] = useState({ amount: "", currency: "CNY", note: "" });
  const [saving, setSaving] = useState(false);
  const [userTags, setUserTags] = useState<Record<string, string[]>>(() => initial?.tags ?? {});
  const [tagDraft, setTagDraft] = useState("");
  /** 自定义卡面正在上传 / 保存 */
  const [coverSaving, setCoverSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 卡背信息（卡号 / 有效期 / 安全码 / 备注 / 币种）与卡包叠卡视图 */
  const [details, setDetails] = useState<Record<string, CardDetails>>(() => initial?.details ?? {});
  const [walletOpen, setWalletOpen] = useState(false);

  const { currency: displayCurrency } = useDisplayCurrency();
  const [rates, setRates] = useState<Record<string, number>>(() => ({ ...FALLBACK_RATES }));

  // 汇率：首帧用兜底值（与服务端一致），挂载前（useLayoutEffect）再合并本地缓存，随后拉一次最新
  useLayoutEffect(() => {
    const cached = readCachedRates();
    if (cached) setRates((prev) => ({ ...prev, ...cached }));
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/rates")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.rates) return;
        setRates((prev) => ({ ...prev, ...data.rates, USD: 1 }));
        writeCachedRates(data.rates);
      })
      .catch(() => {
        /* 汇率失败保留兜底值 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 同一份 payload 既用于服务端注入，也用于挂载后的静默刷新 */
  const applyPayload = (data: {
    regions?: unknown;
    typeOrder?: unknown;
    updatedAt?: unknown;
    error?: unknown;
    amounts?: unknown;
    tags?: unknown;
    holdings?: unknown;
    details?: unknown;
  } | null) => {
    if (!data) return;
    setRegions(Array.isArray(data.regions) ? (data.regions as RegionEntry[]) : []);
    setTypeOrder(Array.isArray(data.typeOrder) ? (data.typeOrder as string[]) : []);
    setUpdatedAt(typeof data.updatedAt === "string" ? data.updatedAt : null);
    setHint(typeof data.error === "string" ? data.error : "");
    const map: Record<string, CardAmount> = {};
    (Array.isArray(data.amounts) ? data.amounts : []).forEach((item) => {
      const amount = item as CardAmount;
      if (amount?.cardKey) map[amount.cardKey] = amount;
    });
    setAmounts(map);
    setUserTags(data.tags && typeof data.tags === "object" ? (data.tags as Record<string, string[]>) : {});
    const held: Record<string, boolean> = {};
    (Array.isArray(data.holdings) ? data.holdings : []).forEach((key) => {
      if (typeof key === "string" && key) held[key] = true;
    });
    setHoldings(held);
    setDetails(data.details && typeof data.details === "object" ? (data.details as Record<string, CardDetails>) : {});
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cards")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) applyPayload(data);
      })
      .catch(() => {
        // 有首屏注入时不打扰用户；没有注入才提示失败
        if (!cancelled && !initial) setHint("卡面库加载失败，稍后重试");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 只在挂载后刷新一次：注入数据变化由服务端重新渲染处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flat = useMemo(() => {
    const list: CardEntry[] = [];
    regions.forEach((entry) => {
      entry.banks.forEach((bank) => {
        bank.cards.forEach((card) => list.push({ card, bank, region: entry.label, tags: cardTagsOf(card.name) }));
      });
    });
    return list;
  }, [regions]);

  /** 地区排序：先按洲，中国各地优先，再按卡面数量 */
  const sortedRegions = useMemo(() => {
    const cardCount = (entry: RegionEntry) => entry.banks.reduce((sum, bank) => sum + bank.cards.length, 0);
    return [...regions].sort((a, b) => {
      const ca = CONTINENT_ORDER.indexOf((REGION_CONTINENT[a.label] ?? "其他") as (typeof CONTINENT_ORDER)[number]);
      const cb = CONTINENT_ORDER.indexOf((REGION_CONTINENT[b.label] ?? "其他") as (typeof CONTINENT_ORDER)[number]);
      if (ca !== cb) return ca - cb;
      const chinaA = CHINA_REGIONS.has(a.label) ? 0 : 1;
      const chinaB = CHINA_REGIONS.has(b.label) ? 0 : 1;
      if (chinaA !== chinaB) return chinaA - chinaB;
      return cardCount(b) - cardCount(a) || a.label.localeCompare(b.label, "zh-Hans-CN");
    });
  }, [regions]);

  /**
   * 每张卡的币种范围：手动覆盖（卡片详情里改过）优先，否则用规则推断。
   * 规则本身在 lib/cardCurrency.ts：卡名关键词 → 发行方产品 → 地区本币 → 卡组织。
   */
  const scopeByCard = useMemo(() => {
    const map: Record<string, { scope: CurrencyScope; info: CurrencyScopeInfo; overridden: boolean }> = {};
    flat.forEach(({ card, bank, region: regionLabel }) => {
      const info = cardCurrencyScope({ name: card.name, brand: card.brand, bank: bank.name, region: regionLabel });
      const override = details[card.file]?.currencyScope;
      const scope = isCurrencyScope(override) ? override : info.scope;
      map[card.file] = { scope, info, overridden: scope !== info.scope };
    });
    return map;
  }, [flat, details]);

  type Facet = "region" | "bank" | "type" | "brand" | "level" | "tag" | "myTag" | "scope" | null;
  const keyword = query.trim().toLowerCase();

  /** 分面匹配：skip 传入当前正在统计的维度时，该维度本身不参与过滤（标准 facet 行为） */
  const matchesExcept = (entry: CardEntry, skip: Facet) => {
    const { card, bank, region: regionLabel, tags } = entry;
    if (mode === "mine" && !holdings[card.file]) return false;
    if (skip !== "region" && region.length > 0 && !region.includes(regionLabel)) return false;
    if (skip !== "bank" && bankFolder.length > 0 && !bankFolder.includes(bank.folder)) return false;
    if (skip !== "type" && type && (card.type || "其他") !== type) return false;
    if (skip !== "brand" && brand.length > 0 && !brand.includes((card.brand || "").trim())) return false;
    if (skip !== "level" && level.length > 0 && !level.includes((card.level || "").trim())) return false;
    if (skip !== "tag" && tag.length > 0 && !tag.some((item) => tags.includes(item))) return false;
    if (skip !== "myTag" && myTag.length > 0 && !myTag.some((item) => (userTags[card.file] ?? []).includes(item))) return false;
    if (skip !== "scope") {
      const scope = scopeByCard[card.file]?.scope ?? "unknown";
      if (scopeFilter && CURRENCY_SCOPE_LABEL[scope] !== scopeFilter) return false;
    }
    if (onlyFilled && !amounts[card.file]) return false;
    if (!keyword) return true;
    return (
      card.name.toLowerCase().includes(keyword) ||
      bank.name.toLowerCase().includes(keyword) ||
      (bank.englishName || "").toLowerCase().includes(keyword) ||
      (card.brand || "").toLowerCase().includes(keyword) ||
      tags.some((item) => item.toLowerCase().includes(keyword))
    );
  };

  const filterBase = (skip: Facet) => flat.filter((entry) => matchesExcept(entry, skip));
  const typeBase = filterBase("type");
  const regionBase = filterBase("region");
  const bankBase = filterBase("bank");
  const brandBase = filterBase("brand");
  const levelBase = filterBase("level");
  const tagBase = filterBase("tag");
  const myTagBase = filterBase("myTag");
  const filtered = filterBase(null);

  const buildTypeOptions = () => {
    const counts = new Map<string, number>();
    typeBase.forEach(({ card }) => counts.set(card.type || "其他", (counts.get(card.type || "其他") ?? 0) + 1));
    const ordered = [...typeOrder.filter((item) => counts.has(item)), ...[...counts.keys()].filter((item) => !typeOrder.includes(item))];
    return [{ key: ALL, count: typeBase.length }, ...ordered.map((item) => ({ key: item, count: counts.get(item) ?? 0 }))];
  };
  const typeOptions = buildTypeOptions();

  const buildRegionOptions = () => {
    const counts = new Map<string, number>();
    regionBase.forEach((entry) => counts.set(entry.region, (counts.get(entry.region) ?? 0) + 1));
    return [
      { key: ALL, count: regionBase.length },
      ...sortedRegions
        .filter((entry) => counts.has(entry.label))
        .map((entry) => ({ key: entry.label, count: counts.get(entry.label) ?? 0 }))
    ];
  };
  const regionOptions = buildRegionOptions();

  const buildUniqueOptions = (values: string[]) => {
    const counts = new Map<string, number>();
    values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
    return [
      { key: ALL, count: values.length },
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }))
    ];
  };
  const brandOptions = buildUniqueOptions(brandBase.map(({ card }) => (card.brand || "").trim()));
  const levelOptions = buildUniqueOptions(levelBase.map(({ card }) => (card.level || "").trim()));
  const tagOptions = buildUniqueOptions(tagBase.flatMap(({ tags }) => tags));

  /** 银行下拉：选项与计数跟随其他筛选（含所选国家地区），值为银行文件夹名（全局唯一） */
  const bankSelectOptions = (() => {
    const list: { value: string; label: string; group?: string }[] = [
      { value: ALL, label: "全部银行" }
    ];
    const banks = new Map<string, { bank: BankEntry; region: string }>();
    bankBase.forEach((entry) => {
      if (!banks.has(entry.bank.folder)) banks.set(entry.bank.folder, { bank: entry.bank, region: entry.region });
    });
    const regionRank = (label: string) => {
      const index = sortedRegions.findIndex((entry) => entry.label === label);
      return index < 0 ? sortedRegions.length : index;
    };
    [...banks.values()]
      .sort((a, b) => regionRank(a.region) - regionRank(b.region) || a.bank.name.localeCompare(b.bank.name, "zh-Hans-CN"))
      .forEach(({ bank, region: regionLabel }) => {
        list.push({
          value: bank.folder,
          label: bank.englishName && bank.englishName !== bank.name ? `${bank.name} ${bank.englishName}` : bank.name,
          // 多选地区时：只有当铺满「全部地区」才需要靠分组区分同名银行，否则按当前选中的地区分组标注
          group: region.length === 0 || region.length > 1 ? `${REGION_CONTINENT[regionLabel] ?? "其他"} · ${regionLabel}` : undefined
        });
      });
    return list;
  })();

  const filledCount = useMemo(() => flat.filter(({ card }) => amounts[card.file]).length, [flat, amounts]);
  const heldCount = useMemo(() => flat.filter(({ card }) => holdings[card.file]).length, [flat, holdings]);

  /** 我的标签（用户自己打的，用于筛选） */
  /** 我的标签：同样按其他筛选联动 */
  const myTagOptions = (() => {
    const counts = new Map<string, number>();
    myTagBase.forEach(({ card }) => {
      (userTags[card.file] ?? []).forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
    });
    if (counts.size === 0) return [];
    return [
      { key: ALL, count: [...counts.values()].reduce((sum, n) => sum + n, 0) },
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }))
    ];
  })();

  /** 币种范围选项（其他维度筛选后重新统计，标准 facet 行为；值用中文标签，和「类型」一致） */
  const scopeBase = filterBase("scope");
  const scopeOptions = (() => {
    const counts = new Map<CurrencyScope, number>();
    scopeBase.forEach(({ card }) => {
      const scope = scopeByCard[card.file]?.scope ?? "unknown";
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    });
    return [
      { key: ALL, count: scopeBase.length },
      ...CURRENCY_SCOPE_ORDER.filter((scope) => counts.has(scope)).map((scope) => ({
        key: CURRENCY_SCOPE_LABEL[scope],
        count: counts.get(scope) ?? 0
      }))
    ];
  })();

  /** 筛选条件变化时回到第一屏 */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [region.join(","), bankFolder.join(","), type, brand.join(","), level.join(","), tag.join(","), myTag.join(","), scopeFilter, onlyFilled, query]);

  /** 卡片详情弹窗：手机上锁住背景滚动，Esc 关闭 */
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [active]);

  /** 切「我的卡 / 全部卡面」时，如果已经滑到列表深处，轻轻带回卡面库顶部 */
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    if (top < -140) window.scrollTo({ top: Math.max(0, window.scrollY + top - 12), behavior: "smooth" });
  }, [mode]);

  const pageItems = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const activeUserTags = active ? userTags[active.card.file] ?? [] : [];
  const activeScope = active ? scopeByCard[active.card.file] : undefined;

  /** 卡包叠卡视图的数据：只放「我的卡」，带卡背信息与当前余额 */
  const walletCards = useMemo<WalletCard[]>(
    () =>
      flat
        .filter(({ card }) => holdings[card.file])
        .map(({ card, bank, region: regionLabel }) => {
          const saved = amounts[card.file];
          const info = details[card.file];
          return {
            key: card.file,
            name: card.name,
            bank: bank.name,
            region: regionLabel,
            type: card.type || "",
            brand: card.brand || "",
            level: card.level || "",
            image: card.file,
            cover: info?.image || `/uploads/cards/${card.file}`,
            amount: saved?.amount ?? 0,
            currency: saved?.currency || info?.currency || REGION_CURRENCY[regionLabel] || "CNY",
            hasAmount: !!saved,
            number: info?.number || "",
            expiry: info?.expiry || "",
            cvv: info?.cvv || "",
            note: info?.note || ""
          };
        }),
    [flat, holdings, amounts, details]
  );

  /** 卡包里改余额 / 卡背信息后，同步回卡面库（金额胶囊、总览条、卡片弹窗都读这里） */
  function applyWalletAmount(cardKey: string, amount: number, currency: string) {
    setAmounts((prev) => ({
      ...prev,
      [cardKey]: {
        cardKey,
        amount,
        currency: currency || prev[cardKey]?.currency || "",
        note: prev[cardKey]?.note ?? "",
        updatedAt: new Date().toISOString()
      }
    }));
  }

  function applyWalletDetails(saved: WalletCardDetails) {
    setDetails((prev) => ({ ...prev, [saved.cardKey]: { ...saved } }));
  }

  /** 卡面实际展示地址：用户上传过自定义卡面就用它，否则回退清单原图 */
  function cardCover(cardFile: string) {
    return details[cardFile]?.image || `/uploads/cards/${cardFile}`;
  }

  /** 上传自定义卡面：先传到素材目录（folder=card），再把地址写进卡片信息 */
  async function uploadCover(entry: CardEntry, file: File) {
    if (coverSaving) return;
    setCoverSaving(true);
    try {
      const form = new FormData();
      form.append("kind", "asset");
      form.append("folder", "card");
      form.append("file", file);
      // 命名规范：银行名 + 卡名 + 地区码（同一地区内卡名不重复）
      form.append("name", `${entry.bank.name}${entry.card.name}`);
      form.append("code", REGION_ISO[entry.region] || "XX");
      const uploadRes = await fetch("/api/v1/upload", { method: "POST", body: form });
      const uploadData = await uploadRes.json().catch(() => null);
      const url = uploadData?.data?.url ?? uploadData?.url;
      if (!uploadRes.ok || !url) {
        showToast(uploadData?.message || uploadData?.error || "上传失败，稍后再试", "err");
        return;
      }
      const res = await fetch("/api/cards/wallet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardKey: entry.card.file, image: url })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.details) {
        showToast(data?.error || "卡面保存失败，稍后再试", "err");
        return;
      }
      setDetails((prev) => ({ ...prev, [entry.card.file]: data.details as CardDetails }));
      showToast("卡面已更新");
    } catch {
      showToast("上传失败，稍后再试", "err");
    } finally {
      setCoverSaving(false);
    }
  }

  /** 恢复清单原图 */
  async function resetCover(entry: CardEntry) {
    if (coverSaving) return;
    setCoverSaving(true);
    try {
      const res = await fetch("/api/cards/wallet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardKey: entry.card.file, image: "" })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.details) {
        showToast(data?.error || "恢复失败，稍后再试", "err");
        return;
      }
      setDetails((prev) => ({ ...prev, [entry.card.file]: data.details as CardDetails }));
      showToast("已恢复清单原图");
    } catch {
      showToast("恢复失败，稍后再试", "err");
    } finally {
      setCoverSaving(false);
    }
  }

  /**
   * 我的卡总览：持有张数 + 各类型张数 + 余额 / 额度 / 其他 三档合计（只统计持有的卡；
   * 按币种折算成显示货币）。三档分开是因为「金额」的含义不同：借记卡 / 预付卡是余额
   * （这一份才是资产分析里计入可用现金的「银行卡现金」），信用卡是额度，其余单列。
   */
  const wallet = useMemo(() => {
    const heldEntries = flat.filter(({ card }) => holdings[card.file]);
    const byType = new Map<string, number>();
    heldEntries.forEach(({ card }) => {
      const key = card.type || "其他";
      byType.set(key, (byType.get(key) ?? 0) + 1);
    });
    const byCurrency = new Map<string, { total: number; count: number }>();
    const groups: Record<AmountGroup, { converted: number; filled: number; missing: string[] }> = {
      balance: { converted: 0, filled: 0, missing: [] },
      limit: { converted: 0, filled: 0, missing: [] },
      other: { converted: 0, filled: 0, missing: [] }
    };
    let filled = 0;
    const displayRate = rates[displayCurrency] || 1;
    heldEntries.forEach(({ card }) => {
      const item = amounts[card.file];
      if (!item) return;
      const code = (item.currency || "").toUpperCase();
      if (!code) return;
      filled += 1;
      const entry = byCurrency.get(code) ?? { total: 0, count: 0 };
      entry.total += item.amount;
      entry.count += 1;
      byCurrency.set(code, entry);
      const bucket = groups[amountGroupOf(card.type || "")];
      bucket.filled += 1;
      const usdRate = rates[code];
      if (usdRate && usdRate > 0) bucket.converted += (item.amount / usdRate) * displayRate;
      else if (!bucket.missing.includes(code)) bucket.missing.push(code);
    });
    return {
      count: heldEntries.length,
      filled,
      byType: [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN")),
      byCurrency: [...byCurrency.entries()].sort((a, b) => b[1].total - a[1].total),
      groups,
      missing: [...new Set([...groups.balance.missing, ...groups.limit.missing, ...groups.other.missing])]
    };
  }, [flat, holdings, amounts, rates, displayCurrency]);

  function openCard(entry: CardEntry) {
    const saved = amounts[entry.card.file];
    setDraft({
      amount: saved ? String(saved.amount) : "",
      currency: saved?.currency || REGION_CURRENCY[entry.region] || "CNY",
      note: saved?.note || ""
    });
    setActive(entry);
  }

  async function saveAmount() {
    if (!active) return;
    const value = Number(draft.amount);
    if (!Number.isFinite(value) || value < 0) {
      showToast("请输入有效金额", "err");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/cards/amounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardKey: active.card.file, amount: value, currency: draft.currency, note: draft.note })
      });
      const data = res.ok ? await res.json() : null;
      if (!res.ok || !data?.amount) throw new Error("save failed");
      setAmounts((prev) => ({ ...prev, [active.card.file]: data.amount as CardAmount }));
      showToast("金额已保存");
    } catch {
      showToast("保存失败，稍后再试", "err");
    } finally {
      setSaving(false);
    }
  }

  async function clearAmount() {
    if (!active) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cards/amounts?cardKey=${encodeURIComponent(active.card.file)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      setAmounts((prev) => {
        const next = { ...prev };
        delete next[active.card.file];
        return next;
      });
      setDraft((prev) => ({ ...prev, amount: "", note: "" }));
      showToast("已清除这张卡的金额");
    } catch {
      showToast("清除失败，稍后再试", "err");
    } finally {
      setSaving(false);
    }
  }

  async function saveTagList(cardKey: string, next: string[]) {
    try {
      const res = await fetch("/api/cards/tags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardKey, tags: next })
      });
      const data = res.ok ? await res.json() : null;
      if (!res.ok || !Array.isArray(data?.tags)) throw new Error("tag save failed");
      const saved = data.tags as string[];
      setUserTags((prev) => ({ ...prev, [cardKey]: saved }));
    } catch {
      showToast("标签保存失败，稍后再试", "err");
    }
  }

  async function setHeld(cardKey: string, held: boolean) {
    try {
      const res = await fetch("/api/cards/holdings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardKey, held })
      });
      if (!res.ok) throw new Error("holding save failed");
      setHoldings((prev) => {
        const next = { ...prev };
        if (held) next[cardKey] = true;
        else delete next[cardKey];
        return next;
      });
      showToast(held ? "已加入我的卡" : "已移出我的卡");
    } catch {
      showToast("操作失败，稍后再试", "err");
    }
  }

  function addTag(value: string) {
    if (!active) return;
    const clean = value.trim().slice(0, 12);
    if (!clean) return;
    const current = userTags[active.card.file] ?? [];
    if (current.includes(clean) || current.length >= 10) return;
    void saveTagList(active.card.file, [...current, clean]);
    setTagDraft("");
  }

  function removeTag(value: string) {
    if (!active) return;
    const current = userTags[active.card.file] ?? [];
    void saveTagList(active.card.file, current.filter((item) => item !== value));
  }

  /** 币种范围手动覆盖：传空字符串 = 恢复自动推断（存 card_details.currency_scope） */
  async function setScopeOverride(cardKey: string, scope: string) {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/cards/wallet", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardKey, currencyScope: scope })
      });
      const data = res.ok ? await res.json() : null;
      if (!res.ok || !data?.details) throw new Error("scope save failed");
      setDetails((prev) => ({ ...prev, [cardKey]: data.details as CardDetails }));
      showToast(scope ? `币种范围已标为「${CURRENCY_SCOPE_LABEL[scope as CurrencyScope]}」` : "币种范围已恢复自动判定");
    } catch {
      showToast("保存失败，稍后再试", "err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={rootRef} className="space-y-4">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-3">
        <div>
          <h2 className="text-lg font-extrabold">卡面库</h2>
          <p className="mt-1 text-xs text-muted">
            {flat.length === 0
              ? "还没有卡面素材"
              : mode === "mine"
                ? `我的卡 ${heldCount} 张${filledCount > 0 ? ` · 已录入金额 ${filledCount} 张` : ""}`
                : `全部卡面 ${flat.length} 张 · ${regions.length} 个地区`}
            {updatedAt ? ` · 更新于 ${new Date(updatedAt).toLocaleDateString("zh-CN")}` : ""}
          </p>
        </div>
        {/* 手机：模式切换独占一行（分段控件），卡包 / 已录入并排；≥sm 合并回一行靠右 */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex w-full items-center gap-1 rounded-full border border-edge bg-white p-1 sm:w-auto dark:border-white/10 dark:bg-[#1c222d]">
            <button
              type="button"
              onClick={() => setMode("mine")}
              aria-pressed={mode === "mine"}
              className={`h-9 flex-1 rounded-full px-3.5 text-xs font-semibold transition-colors duration-200 sm:flex-none sm:px-4 ${
                mode === "mine"
                  ? "bg-[#111] text-white shadow-sm dark:bg-white dark:text-[#111]"
                  : "text-ink-2 hover:bg-brand-hover dark:text-white/80 dark:hover:bg-white/10"
              }`}
            >
              我的卡 {heldCount}
            </button>
            <button
              type="button"
              onClick={() => setMode("all")}
              aria-pressed={mode === "all"}
              className={`h-9 flex-1 rounded-full px-3.5 text-xs font-semibold transition-colors duration-200 sm:flex-none sm:px-4 ${
                mode === "all"
                  ? "bg-[#111] text-white shadow-sm dark:bg-white dark:text-[#111]"
                  : "text-ink-2 hover:bg-brand-hover dark:text-white/80 dark:hover:bg-white/10"
              }`}
            >
              全部卡面 {flat.length}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            <button
              type="button"
              onClick={() => setWalletOpen(true)}
              title="打开卡包：堆叠浏览卡片、翻到卡背看有效期与安全码、记录余额历史"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-edge bg-white px-3.5 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:border-edge-strong hover:bg-brand-hover sm:h-9 dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <rect x="4" y="8" width="15" height="10" rx="2.4" />
                <path d="M7.4 5.6h12.2a1.8 1.8 0 0 1 1.8 1.8v7.2" />
              </svg>
              卡包
            </button>
            <button
              type="button"
              onClick={() => setOnlyFilled((value) => !value)}
              title="只看已录入金额的卡"
              aria-pressed={onlyFilled}
              className={`h-10 rounded-full border px-3.5 text-xs font-semibold transition-all duration-200 sm:h-9 ${
                onlyFilled
                  ? "border-[#111] bg-[#111] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#111]"
                  : "border-edge bg-white text-ink-2 hover:border-edge-strong hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
              }`}
            >
              已录入 {filledCount}
            </button>
          </div>
        </div>
      </div>

      {/* 搜索：独立一行；手机上高度给到 44px，输入后右侧出现清空按钮 */}
      <div className="relative w-full max-w-[520px]">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted">
          <circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />
        </svg>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索银行、卡片名称或关键词"
          aria-label="搜索卡面"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          className={`h-11 w-full rounded-xl border border-edge bg-white pl-10 pr-11 text-[15px] text-ink placeholder:text-faint transition-all duration-200 hover:border-edge-strong sm:h-10 sm:text-sm dark:bg-[#1c222d] ${FOCUS_RING}`}
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="清空搜索"
            className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted transition-colors duration-200 hover:bg-bg-gray hover:text-ink-2 dark:hover:bg-white/10"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* 「我的卡」总览只属于我的卡包：切到「全部卡面」挑选时不再出现 */}
      {mode === "mine" && wallet.count > 0 && (
        <div className="card flex flex-col gap-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted">我的卡</span>
              <span className="text-sm font-bold tabular-nums text-ink">{wallet.count} 张</span>
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-muted">
              {wallet.byType.map(([label, count]) => (
                <span key={label}>
                  {label} <b className="tabular-nums text-ink-2">{count}</b>
                </span>
              ))}
            </span>
            <span className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 sm:ml-auto sm:w-auto sm:justify-end">
              {wallet.groups.balance.filled > 0 && (
                <span className="flex items-center gap-1.5" title="借记卡 / 预付卡的余额合计 —— 这一份就是资产分析里计入可用现金与净资产的「银行卡现金」">
                  <span className="text-xs font-semibold text-muted">余额合计</span>
                  <span className="text-sm font-bold tabular-nums text-ink">
                    ≈ {currencySymbol(displayCurrency)}
                    {wallet.groups.balance.converted.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </span>
              )}
              {wallet.groups.limit.filled > 0 && (
                <span className="flex items-center gap-1.5" title="信用卡额度合计 —— 额度是可透支的上限，不是你的钱，不计入可用现金">
                  <span className="text-xs font-semibold text-muted">额度合计</span>
                  <span className="text-sm font-bold tabular-nums text-ink">
                    ≈ {currencySymbol(displayCurrency)}
                    {wallet.groups.limit.converted.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </span>
              )}
              {wallet.groups.other.filled > 0 && (
                <span className="flex items-center gap-1.5" title="其他类型卡片录入的金额（既不是借记卡 / 预付卡余额，也不是信用卡额度），不计入现金">
                  <span className="text-xs font-semibold text-muted">其他合计</span>
                  <span className="text-sm font-bold tabular-nums text-ink">
                    ≈ {currencySymbol(displayCurrency)}
                    {wallet.groups.other.converted.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </span>
              )}
              {wallet.filled === 0 && <span className="text-xs text-faint">未录入（打开卡片可录入金额）</span>}
            </span>
          </div>
          {wallet.byCurrency.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-edge pt-2">
              <span className="text-[11px] text-faint">已录入 {wallet.filled} 张</span>
              {wallet.byCurrency.map(([code, item]) => (
                <span key={code} className="rounded-full bg-bg-gray px-2.5 py-1 text-[11px] font-semibold tabular-nums text-muted dark:bg-white/5">
                  {code} {item.total.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}
                  <i className="ml-1 not-italic text-faint">×{item.count}</i>
                </span>
              ))}
              {wallet.missing.length > 0 && (
                <span className="text-[11px] text-faint">（{wallet.missing.join(" / ")} 暂无汇率，未计入折算）</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card flex flex-col gap-3 p-3">
        {/* 类型胶囊：手机上横向滑动一行，不再换行占掉三四行高度 */}
        <div className="ticker-scroll -mx-3 overflow-x-auto overscroll-x-contain px-3 sm:mx-0 sm:overflow-visible sm:px-0">
          <PillGroup
            label="类型"
            options={typeOptions}
            values={type ? [type] : []}
            onToggle={(key) => setType((prev) => (prev === key ? "" : key))}
            onClear={() => setType("")}
          />
        </div>
        {/* 币种范围：单币 / 双币 / 多币种（规则推断 + 卡片详情里可手动覆盖） */}
        <div className="ticker-scroll -mx-3 overflow-x-auto overscroll-x-contain px-3 sm:mx-0 sm:overflow-visible sm:px-0">
          <PillGroup
            label="币种"
            options={scopeOptions}
            values={scopeFilter ? [scopeFilter] : []}
            onToggle={(key) => setScopeFilter((prev) => (prev === key ? "" : key))}
            onClear={() => setScopeFilter("")}
          />
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <MultiSelect
            label="地区"
            allLabel="全部地区"
            values={region}
            options={regionOptions
              .slice(1)
              .map((option) => ({
                value: option.key,
                label: `${option.key}（${option.count}）`,
                group: REGION_CONTINENT[option.key] ?? "其他",
                icon: REGION_ISO[option.key] ? <CurrencyFlag market={REGION_ISO[option.key]} size={16} /> : null
              }))}
            onChange={(next) => {
              setRegion(next);
              setBankFolder([]);
            }}
          />
          <MultiSelect
            label="银行"
            allLabel="全部银行"
            values={bankFolder}
            options={bankSelectOptions.filter((option) => option.value !== ALL)}
            onChange={setBankFolder}
          />
          <MultiSelect
            label="卡组织"
            allLabel="全部卡组织"
            values={brand}
            options={brandOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))}
            onChange={setBrand}
          />
          <MultiSelect
            label="等级"
            allLabel="全部等级"
            values={level}
            options={levelOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))}
            onChange={setLevel}
          />
          <MultiSelect
            label="主题"
            allLabel="全部主题"
            values={tag}
            options={tagOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))}
            onChange={setTag}
          />
          {myTagOptions.length > 0 && (
            <MultiSelect
              label="我的标签"
              allLabel="全部我的标签"
              values={myTag}
              options={myTagOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))}
              onChange={setMyTag}
            />
          )}
        </div>
        {Boolean(type || region.length > 0 || bankFolder.length > 0 || brand.length > 0 || level.length > 0 || tag.length > 0 || myTag.length > 0 || scopeFilter || onlyFilled || query.trim()) && (
          <button
            type="button"
            onClick={() => {
              setType("");
              setRegion([]);
              setBankFolder([]);
              setBrand([]);
              setLevel([]);
              setTag([]);
              setMyTag([]);
              setScopeFilter("");
              setOnlyFilled(false);
              setQuery("");
            }}
            className="self-start rounded-full border border-edge px-3 py-1.5 text-[11px] font-semibold text-muted transition-colors duration-200 hover:border-edge-strong hover:bg-brand-hover hover:text-ink max-sm:px-4 max-sm:py-2 max-sm:text-[12px]"
          >
            清空全部筛选
          </button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-40 animate-pulse rounded-2xl bg-bg-gray" />
          ))}
        </div>
      ) : hint ? (
        <div className="card py-16 text-center text-sm text-muted">{hint}</div>
      ) : mode === "mine" && heldCount === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted">还没有添加卡片 —— 卡面库默认只显示你持有的卡</p>
          <button
            type="button"
            onClick={() => setMode("all")}
            className="h-11 rounded-full border border-edge-strong bg-white px-5 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover sm:h-9 sm:px-4 dark:bg-[#1c1c1e] dark:text-white"
          >
            去全部卡面挑一张
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card py-16 text-center text-sm text-muted">
          {mode === "mine" ? "持有的卡里没有符合条件的卡面" : "没有符合条件的卡面"}
        </div>
      ) : (
        <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {pageItems.map(({ card, bank, region: regionLabel, tags }) => {
            const saved = amounts[card.file];
            const mine = userTags[card.file] ?? [];
            const shownTags = [...mine, ...tags.filter((item) => !mine.includes(item))];
            const isHeld = !!holdings[card.file];
            const scope = scopeByCard[card.file]?.scope ?? "unknown";
            return (
              <button
                key={`${bank.folder}-${card.file}`}
                type="button"
                onClick={() => openCard({ card, bank, region: regionLabel, tags })}
                className="group flex flex-col overflow-hidden rounded-2xl border border-edge bg-white text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-pop active:scale-[.995] [contain-intrinsic-size:auto_190px] [content-visibility:auto] dark:bg-[#16181d]"
              >
                {/* 卡片底托：留白 + 圆角裁切，让每张卡看起来都像一张实体卡（素材自带圆角的也保持一致） */}
                <span className="block w-full bg-bg-gray/60 p-2.5 dark:bg-white/[0.04]">
                  <span className="relative block overflow-hidden rounded-[10px] bg-bg-gray shadow-sm ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10">
                    <img
                      src={cardCover(card.file)}
                      alt={card.name}
                      loading="lazy"
                      decoding="async"
                      className="aspect-[1.586] w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                    />
                    <span className="touch-always pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                    {saved && (
                      <span className="absolute bottom-2 left-2 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                        {fmtAmount(saved.amount, saved.currency)}
                      </span>
                    )}
                    <span className="touch-always absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                      {card.type || "未分类"}
                    </span>
                    {isHeld && (
                      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-[#3297f6] px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="m2.4 6.4 2.5 2.5 4.7-5.8" /></svg>
                        我的卡
                      </span>
                    )}
                    {mode === "all" && (
                      <span
                        role="button"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation();
                          void setHeld(card.file, !isHeld);
                        }}
                        className={`absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold shadow-sm transition-colors duration-200 after:absolute after:-inset-1 after:content-[''] active:scale-95 sm:bottom-2 sm:right-2 sm:px-2 sm:py-0.5 sm:text-[10px] ${
                          isHeld ? "bg-white/90 text-[#2f6fed]" : "bg-white/90 text-ink-2 hover:bg-white"
                        }`}
                      >
                        {isHeld ? "移出" : "+ 加入"}
                      </span>
                    )}
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                  <b className="truncate text-[13px] font-semibold text-ink">{card.name}</b>
                  <small className="truncate text-[11px] text-muted">
                    {bank.name}
                    {card.brand ? ` · ${card.brand}` : ""}
                    {card.level ? ` · ${card.level}` : ""}
                  </small>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <i
                      title={currencyScopeSummary(scopeByCard[card.file]?.info ?? { scope, currencies: [], reason: "", confidence: "low" })}
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold not-italic sm:py-[1px] sm:text-[9px] ${SCOPE_CHIP_CLASS[scope]}`}
                    >
                      {CURRENCY_SCOPE_LABEL[scope]}
                    </i>
                    {shownTags.slice(0, 3).map((item) => (
                        <i
                          key={item}
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold not-italic sm:py-[1px] sm:text-[9px] ${
                            mine.includes(item)
                              ? "bg-[#3297f6]/12 text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]"
                              : "bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white/70"
                          }`}
                        >
                          {item}
                        </i>
                      ))}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {filtered.length > pageItems.length && (
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            className="card mx-auto flex min-h-12 w-full items-center justify-center gap-1.5 py-3 text-xs font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink"
          >
            加载更多（剩余 {filtered.length - pageItems.length} 张）
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="m5 7 5 5 5-5" /></svg>
          </button>
        )}
        </>
      )}

      {active && (
        <div className="fixed inset-0 z-[10002] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={() => setActive(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-edge bg-white shadow-2xl supports-[height:100dvh]:max-h-[92dvh] sm:rounded-card dark:border-white/10 dark:bg-[#16181d]"
            onClick={(event) => event.stopPropagation()}
          >
            {/* 手机：底部抽屉的抓手 */}
            <span className="mx-auto mt-2.5 block h-1 w-10 flex-none rounded-full bg-edge-strong sm:hidden" />
            <div className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3.5 sm:px-5 sm:py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-bold text-ink">{active.card.name}</h3>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {active.region} · {active.bank.name}
                  {active.bank.englishName && active.bank.englishName !== active.bank.name ? `（${active.bank.englishName}）` : ""}
                </p>
                {[...activeUserTags, ...active.tags.filter((item) => !activeUserTags.includes(item))].length > 0 && (
                  <p className="mt-1.5 flex flex-wrap gap-1">
                    {[...activeUserTags, ...active.tags.filter((item) => !activeUserTags.includes(item))].map((item) => (
                      <span
                        key={item}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          activeUserTags.includes(item)
                            ? "bg-[#3297f6]/12 text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]"
                            : "bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white/70"
                        }`}
                      >
                        {item}
                      </span>
                    ))}
                  </p>
                )}
              </div>
              <button type="button" onClick={() => setActive(null)} aria-label="关闭" className="grid h-9 w-9 flex-none place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2 sm:h-8 sm:w-8">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto overscroll-contain bg-bg-gray px-4 py-4 sm:px-5 sm:py-5 dark:bg-black/20">
              <img src={cardCover(active.card.file)} alt={active.card.name} className="mx-auto w-full max-w-[560px] rounded-xl shadow-pop" />
              <div className="mx-auto mt-4 grid max-w-[560px] grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">类型<b className="ml-1 text-ink">{active.card.type || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">卡组织<b className="ml-1 text-ink">{active.card.brand || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">等级<b className="ml-1 text-ink">{active.card.level || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">卡号前几位<b className="ml-1 text-ink">{active.card.bins?.length ? active.card.bins.join(" / ") : "—"}</b></span>
              </div>
              {/* 币种范围：规则推断 + 手动覆盖（存 card_details.currency_scope） */}
              {activeScope && (
                <div className="mx-auto mt-2 max-w-[560px] rounded-xl bg-white px-3 py-2.5 dark:bg-[#1c222d]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] font-semibold text-muted">币种范围</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${SCOPE_CHIP_CLASS[activeScope.scope]}`}>
                      {CURRENCY_SCOPE_LABEL[activeScope.scope]}
                    </span>
                    <span className="min-w-0 flex-1 text-[11px] text-faint">
                      {activeScope.overridden ? "手动标记" : "自动推断"}：{currencyScopeSummary(activeScope.info)}
                      {activeScope.info.confidence === "high" ? "" : `（${activeScope.info.reason}）`}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-faint">改成</span>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void setScopeOverride(active.card.file, "")}
                      className={`h-8 rounded-full border px-3 text-[11px] font-semibold transition-colors duration-200 disabled:opacity-50 max-sm:h-9 ${
                        activeScope.overridden
                          ? "border-edge bg-white text-ink-2 hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
                          : "border-[#111] bg-[#111] text-white dark:border-white dark:bg-white dark:text-[#111]"
                      }`}
                    >
                      自动
                    </button>
                    {CURRENCY_SCOPE_ORDER.map((value) => (
                      <button
                        key={value}
                        type="button"
                        disabled={saving}
                        onClick={() => void setScopeOverride(active.card.file, value)}
                        className={`h-8 rounded-full border px-3 text-[11px] font-semibold transition-colors duration-200 disabled:opacity-50 max-sm:h-9 ${
                          activeScope.overridden && activeScope.scope === value
                            ? "border-[#111] bg-[#111] text-white dark:border-white dark:bg-white dark:text-[#111]"
                            : "border-edge bg-white text-ink-2 hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
                        }`}
                      >
                        {CURRENCY_SCOPE_LABEL[value]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <p className="mx-auto mt-2 max-w-[560px] text-center text-[11px] text-faint">
                原图 {fileExt(active.card.file)}
                {active.card.bytes ? ` · ${fmtBytes(active.card.bytes)}` : ""}
                {` · ${active.card.file.split("/").slice(0, 2).join(" / ").split("/").map((segment) => decodeURIComponent(segment)).join(" / ")}`}
              </p>
            </div>
            <div className="border-t border-edge px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3.5 sm:px-5 sm:py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                  {holdings[active.card.file] ? "这张卡已在「我的卡」里，回卡面库默认就能看到" : "加入「我的卡」后，卡面库默认列表里就会出现它"}
                </span>
                <button
                  type="button"
                  onClick={() => void setHeld(active.card.file, !holdings[active.card.file])}
                  className={`h-10 rounded-full border px-3.5 text-xs font-semibold transition-all duration-200 hover:-translate-y-px active:scale-[.97] sm:h-8 ${
                    holdings[active.card.file]
                      ? "border-edge-strong bg-white text-muted hover:bg-brand-hover hover:text-ink dark:bg-[#1c1c1e] dark:text-white/80"
                      : "border-[#3297f6] bg-[#3297f6] text-white hover:brightness-105"
                  }`}
                >
                  {holdings[active.card.file] ? "移出我的卡" : "加入我的卡"}
                </button>
              </div>
              {/* 自定义卡面：清单原图不合意时上传自己的卡片照片（只影响自己这一份） */}
              <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
                <span className="text-[11px] font-semibold text-muted">卡面</span>
                <span className="rounded-full bg-bg-gray px-2 py-0.5 text-[10px] font-semibold text-muted dark:bg-white/5">
                  {details[active.card.file]?.image ? "自定义照片" : "清单原图"}
                </span>
                <label
                  className={`inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-full border border-edge bg-white px-3.5 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:border-edge-strong hover:bg-brand-hover sm:h-8 dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10 ${
                    coverSaving ? "pointer-events-none opacity-50" : ""
                  }`}
                  title="上传自己的卡片照片替换清单原图（建议用标准卡面比例 1.586:1；支持 JPG / PNG / WEBP，最大 2MB）"
                >
                  {coverSaving ? "处理中…" : "上传卡面"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadCover(active, file);
                    }}
                  />
                </label>
                {details[active.card.file]?.image && (
                  <button
                    type="button"
                    disabled={coverSaving}
                    onClick={() => void resetCover(active)}
                    className="h-10 rounded-full px-3 text-xs font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink disabled:opacity-50 sm:h-8"
                  >
                    恢复原图
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 max-sm:flex-1">
                  <span className="text-[11px] font-semibold text-muted">金额</span>
                  <span className="flex items-center gap-1 rounded-xl border border-edge bg-white px-2 transition-all duration-200 focus-within:border-edge-strong focus-within:shadow-[0_0_0_3px_rgba(107,114,128,.15)] dark:bg-[#1c222d] dark:focus-within:border-white/20 dark:focus-within:shadow-[0_0_0_3px_rgba(255,255,255,.10)]">
                    <span className="text-xs font-semibold text-muted">{currencySymbol(draft.currency)}</span>
                    <input
                      value={draft.amount}
                      onChange={(event) => setDraft((prev) => ({ ...prev, amount: event.target.value.replace(/[^\d.]/g, "") }))}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-11 w-full min-w-[96px] bg-transparent text-sm tabular-nums text-ink outline-none placeholder:text-faint sm:h-9 sm:w-[130px]"
                    />
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-muted">币种</span>
                  <select
                    value={draft.currency}
                    onChange={(event) => setDraft((prev) => ({ ...prev, currency: event.target.value }))}
                    className={`h-11 rounded-xl border border-edge bg-white px-2 text-xs font-semibold text-ink transition-all duration-200 sm:h-9 dark:bg-[#1c222d] ${FOCUS_RING}`}
                  >
                    {CARD_CURRENCIES.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.code} · {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-[180px] flex-1 flex-col gap-1">
                  <span className="text-[11px] font-semibold text-muted">备注（可选）</span>
                  <input
                    value={draft.note}
                    onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
                    maxLength={100}
                    placeholder="额度 / 余额 / 其他说明"
                    className={`h-11 rounded-xl border border-edge bg-white px-3 text-xs text-ink placeholder:text-faint transition-all duration-200 sm:h-9 dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                </label>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveAmount()}
                  className="h-11 rounded-xl border border-edge-strong bg-white px-4 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover active:scale-[.97] disabled:opacity-50 sm:h-9 max-sm:flex-1 dark:bg-[#1c1c1e] dark:text-white"
                >
                  保存
                </button>
                {amounts[active.card.file] && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void clearAmount()}
                    className="h-11 rounded-xl px-4 text-xs font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink disabled:opacity-50 sm:h-9 sm:px-3"
                  >
                    清除
                  </button>
                )}
              </div>
              {amounts[active.card.file] && (
                <p className="mt-2 text-[11px] text-faint">
                  已录入 {fmtAmount(amounts[active.card.file].amount, amounts[active.card.file].currency)}
                  {amounts[active.card.file].note ? ` · ${amounts[active.card.file].note}` : ""}
                  {" · "}
                  {new Date(amounts[active.card.file].updatedAt).toLocaleString("zh-CN", { hour12: false })}
                </p>
              )}
              {/* 我的标签：用户自己维护（虚拟卡 / 实体卡 / 材质 / 收藏 …），最多 10 个 */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-edge pt-3">
                <span className="text-[11px] font-semibold text-muted">我的标签</span>
                {activeUserTags.map((item) => (
                  <span key={item} className="inline-flex items-center gap-1 rounded-full bg-[#3297f6]/12 px-2.5 py-1 text-[12px] font-semibold text-[#2f6fed] sm:px-2 sm:py-0.5 sm:text-[11px] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]">
                    {item}
                    <button
                      type="button"
                      onClick={() => removeTag(item)}
                      aria-label={`移除标签 ${item}`}
                      className="relative grid h-4 w-4 place-items-center rounded-full transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:bg-black/10 sm:h-3.5 sm:w-3.5 dark:hover:bg-white/10"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="h-2.5 w-2.5"><path d="m6 6 12 12M18 6 6 18" /></svg>
                    </button>
                  </span>
                ))}
                <input
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag(tagDraft);
                    }
                  }}
                  maxLength={12}
                  placeholder="添加标签，回车"
                  className={`h-9 w-[140px] rounded-full border border-edge bg-white px-2.5 text-[12px] text-ink placeholder:text-faint transition-all duration-200 sm:h-7 sm:w-[130px] sm:text-[11px] dark:bg-[#1c222d] ${FOCUS_RING}`}
                />
                {TAG_SUGGESTIONS.filter((item) => !activeUserTags.includes(item)).slice(0, 5).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => addTag(item)}
                    className="rounded-full border border-dashed border-edge-strong px-2.5 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink sm:px-2 sm:py-0.5 sm:text-[11px]"
                  >
                    + {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {walletOpen && (
        <CardWalletStack
          cards={walletCards}
          onClose={() => setWalletOpen(false)}
          onAddCards={() => {
            setWalletOpen(false);
            setMode("all");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onAmountChange={applyWalletAmount}
          onDetailsSaved={applyWalletDetails}
        />
      )}
    </div>
  );
}
