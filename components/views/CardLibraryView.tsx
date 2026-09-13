"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { showToast } from "@/lib/toast";
import { cardTagsOf } from "@/lib/cardTags";
import CurrencyFlag from "@/components/CurrencyFlag";
import CardWalletStack, { type WalletCard, type WalletCardDetails } from "@/components/CardWalletStack";
import { FALLBACK_RATES } from "@/lib/types";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { usePersistedState } from "@/lib/usePersistedState";
import { readCachedRates, writeCachedRates } from "@/lib/ratesCache";
import { REGION_CURRENCY, currencySymbol } from "@/lib/cardCurrencies";
import { searchKey } from "@/lib/hanConvert";
import { bankTitle, cardTitle, regionTitle, typeTitle, type CardScript } from "@/lib/cardNamesEn";
import { cardAssetId, manifestCoverUrl } from "@/lib/cardAssets";
import {
  CURRENCY_SCOPE_LABEL,
  CURRENCY_SCOPE_ORDER,
  cardCurrencyScope,
  cardCurrencyChoicesFor,
  currencyScopeSummary,
  currencyName,
  isCurrencyScope,
  type CurrencyScope,
  type CurrencyScopeInfo
} from "@/lib/cardCurrency";
import type { CardLibraryPayload } from "@/lib/cardLibrary";
import type { CardDetails } from "@/lib/cardWallet";
import type { CustomCard } from "@/lib/cardCustom";
import { CARD_VARIANT_FACES, CARD_VARIANT_MERGE_KEYS, CARD_VARIANT_MERGED, type CardFace } from "@/lib/cardVariants";

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
  /** 用户自建的卡（素材库里没有），删除入口只对它开放 */
  custom?: boolean;
  customId?: string;
  /** 同一张卡的另一版卡面（旧卡面等）：详情页可以翻看 */
  faces?: CardFace[];
  /** 自建卡的创建时间：用来算「NEW」角标还在不在 */
  createdAt?: string;
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
/** 首屏先铺 32 张（手机两列 = 16 行） */
const PAGE_SIZE_FIRST = 32;
/**
 * 「加载更多」一次追加的张数：12 张是三种布局的「整行临界点」——
 * 网格是 2 / 3 / 4 列（手机 / 平板 / 桌面），12 恰好都能铺满整行（6 / 4 / 3 行），
 * 不会出现半截的一行；实测一屏能放 8 / 11 / 13 张，所以点一次差不多就是「补一屏」。
 */
const PAGE_SIZE_STEP = 12;
/** 新增卡片表单的类型选项（与后端白名单一致） */
const CARD_TYPE_OPTIONS = ["借记卡", "信用卡", "预付卡", "签账卡", "取现卡", "交通卡", "礼品卡", "虚拟卡", "其他"];
/** 新建的卡 3 天内挂「NEW」角标 */
const NEW_CARD_MS = 3 * 24 * 60 * 60 * 1000;

type LibrarySort = "default" | "name" | "bank";
const LIBRARY_SORT_LABEL: Record<LibrarySort, string> = {
  default: "默认顺序",
  name: "按卡名",
  bank: "按银行"
};

/** 卡名 / 银行名的显示方式：原文 = 素材怎么写就怎么显示，简体 / 繁體 / 英文 = 查内置对照表（只影响显示，不改数据） */
const SCRIPT_OPTIONS: { value: CardScript; label: string; hint: string }[] = [
  { value: "original", label: "原文", hint: "保留素材里的原始写法" },
  { value: "simplified", label: "简体", hint: "繁体卡名一键转简体，英文卡名换成中文名（不联网）" },
  { value: "traditional", label: "繁體", hint: "简体卡名一键转繁體，英文卡名换成中文名（不联网）" },
  { value: "english", label: "英文", hint: "中文卡名换成英文名，本来就英文的保持英文（不联网）" }
];

/**
 * 自建卡的创建时间戳（不是自建卡返回 0）：用来决定「置顶」和 NEW 角标。
 *
 * 只认自建卡 —— 点「加入我的卡」收进来的都是素材库里的旧卡，既不该挂 NEW，
 * 也不该浮到最上面（否则用户会以为它们是自己新上传的卡）。
 */
function customCardStamp(card: { custom?: boolean; createdAt?: string }): number {
  if (!card.custom || !card.createdAt) return 0;
  const created = Date.parse(card.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/**
 * 「新入库」的时间戳：优先用素材首次入库时间（`firstSeen`，导入的新卡与自建卡都会登记），
 * 表里没有时兜底用自建卡自己的创建时间。
 */
function firstSeenStampOf(
  card: { custom?: boolean; createdAt?: string; file: string },
  firstSeen: Record<string, string>
): number {
  const seen = Date.parse(firstSeen?.[card.file] ?? "");
  if (Number.isFinite(seen) && seen > 0) return seen;
  return customCardStamp(card);
}

/** 是不是 3 天内「新入库」的卡：置顶与 NEW 角标同一套判断（导入的新卡也算） */
function isFreshEntry(
  card: { custom?: boolean; createdAt?: string; file: string },
  firstSeen: Record<string, string>,
  nowMs: number
): boolean {
  const stamp = firstSeenStampOf(card, firstSeen);
  return stamp > 0 && nowMs > 0 && nowMs - stamp < NEW_CARD_MS;
}
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

/** 币种范围角标配色：单币绿（只有一种）、双币蓝、多币种紫、待确认琥珀 —— 一眼能分出来 */
const SCOPE_CHIP_CLASS: Record<CurrencyScope, string> = {
  /**
   * 币种胶囊：底色不再是彩色块，跟旁边的「版本 / 主题」标签一样用中性灰 ——
   * 一排标签形状统一，彩色只留在文字上，卡片上就不会出现一块块抢眼的色斑。
   * 文字统一压深到 700~800 号色：绿 / 蓝 / 紫 是同一个冷色家族，按「币种数量」递进；
   * 琥珀只留给「待确认」这种需要补数据的状态，是整排唯一的暖色。
   */
  single: "bg-ink/[0.06] text-[#115e59] dark:bg-white/10 dark:text-[#6ee7b7]",
  dual: "bg-ink/[0.06] text-[#1e40af] dark:bg-white/10 dark:text-[#93c5fd]",
  multi: "bg-ink/[0.06] text-[#5b21b6] dark:bg-white/10 dark:text-[#c4b5fd]",
  unknown: "bg-ink/[0.06] text-[#92400e] dark:bg-white/10 dark:text-[#fcd34d]"
};

/** 下拉选项里的小圆点：和角标同一套颜色，方便对照 */
const SCOPE_DOT_CLASS: Record<CurrencyScope, string> = {
  single: "bg-[#115e59]",
  dual: "bg-[#1e40af]",
  multi: "bg-[#5b21b6]",
  unknown: "bg-[#92400e]"
};

/** 币种范围的中文标签 → 枚举值（下拉选项里要按标签取颜色） */
const scopeOfLabel = (label: string): CurrencyScope =>
  CURRENCY_SCOPE_ORDER.find((scope) => CURRENCY_SCOPE_LABEL[scope] === label) ?? "unknown";

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
  renderIcon,
  single = false
}: {
  label: string;
  allLabel: string;
  options: { value: string; label: string; group?: string; icon?: React.ReactNode }[];
  values: string[];
  onChange: (next: string[]) => void;
  /** 摘要按钮里显示的图标（按已选值取），用于地区国旗这类标识 */
  renderIcon?: (value: string) => React.ReactNode;
  /** 单选：点一项即选中并关闭面板（再点一次 = 取消），用于币种范围这种只有一个值的维度 */
  single?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const labelOf = (value: string) => options.find((option) => option.value === value)?.label ?? value;
  const iconOf = (value: string) => options.find((option) => option.value === value)?.icon ?? null;
  const summary = values.length === 0 ? allLabel : values.length === 1 ? labelOf(values[0]) : `${labelOf(values[0])} +${values.length - 1}`;
  const toggle = (value: string) => {
    if (single) {
      onChange(values.includes(value) ? [] : [value]);
      setOpen(false);
      return;
    }
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
            {/* 桌面端也要保持在遮罩之上（原来的 sm:z-40 会被 z-[60] 的遮罩盖住，
                鼠标实际落在遮罩上 → 滑轮滚的是网页而不是列表） */}
            <div className="thin-scrollbar fixed inset-x-0 bottom-0 z-[70] max-h-[72vh] space-y-1 overflow-y-auto overscroll-contain rounded-t-2xl border-t border-edge-strong bg-white px-1 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-pop dark:border-white/10 dark:bg-[#1b2029] sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1 sm:max-h-[320px] sm:w-full sm:min-w-[220px] sm:rounded-xl sm:border sm:pb-1">
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
                onClick={() => {
                  onChange([]);
                  if (single) setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-[13px] font-semibold transition-colors sm:py-2 sm:text-xs ${
                  // 选中态统一用品牌蓝（和下面各选项一致），不再用和分组标题同色的灰底
                  values.length === 0
                    ? "bg-[#3297f6]/12 text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]"
                    : "text-ink hover:bg-brand-hover dark:text-white/85 dark:hover:bg-white/10"
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
                    {/* 分组标题：小一号 + 字距 + 一条细分隔线，和可点的选项明显分层 */}
                    {header && (
                      <span className="mt-1 block border-t border-edge/70 px-3.5 pb-1 pt-2 text-[10px] font-semibold tracking-[0.08em] text-faint dark:border-white/10">
                        {header}
                      </span>
                    )}
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
                        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 flex-none">
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
  /** 卡面首次入库时间（卡面 key → ISO）：3 天内的置顶 + 挂 NEW */
  const [firstSeen, setFirstSeen] = useState<Record<string, string>>(() => initial?.firstSeen ?? {});
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
  const [query, setQuery] = useState("");
  /** 排序方式（记住选择）：默认顺序 / 按卡名 / 按银行 */
  const [storedSort, setSort] = usePersistedState<LibrarySort>("fire:card-library-sort", "default");
  /** 旧版本可能存过已删除的排序值（比如按热度 / 按年份），这里兜回默认，避免下拉与列表对不上 */
  const sort: LibrarySort = storedSort in LIBRARY_SORT_LABEL ? storedSort : "default";
  /** 显示方式：原文 / 简体 / 繁體 / 英文（记住选择；历史遗留的非法值兜回原文） */
  const [storedScript, setScript] = usePersistedState<CardScript>("fire:card-library-script", "original");
  const script: CardScript = SCRIPT_OPTIONS.some((option) => option.value === storedScript) ? storedScript : "original";
  const currentScript = SCRIPT_OPTIONS.find((option) => option.value === script) ?? SCRIPT_OPTIONS[0];
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE_FIRST);
  /** 详细筛选（币种范围 / 地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签）默认收起，点工具栏的「筛选」展开 */
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** 显示方式（原文 / 简体 / 繁體 / 英文）：收成一枚按钮 + 小菜单，不再平铺四个档位 */
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  /** 手机端：滑到列表深处浮出「回到顶部」 */
  const [showTop, setShowTop] = useState(false);
  /** 新增卡片弹窗：搜索 / 地区 / 每次展示条数 */
  const [addOpen, setAddOpen] = useState(false);
  /** 新增卡片表单：卡面（上传后的地址）+ 卡片信息 */
  const [newCard, setNewCard] = useState({
    name: "",
    bank: "",
    region: "中国内地",
    type: "借记卡",
    brand: "",
    level: "",
    currencyScope: "single" as CurrencyScope
  });
  const [newImage, setNewImage] = useState("");
  const [newUploading, setNewUploading] = useState(false);
  const [newSaving, setNewSaving] = useState(false);
  /** 卡面拖拽上传：拖到框里高亮提示 */
  const [dragActive, setDragActive] = useState(false);
  /** 卡面识别中（上传完自动交给 DeepSeek 读字段） */
  const [recognizing, setRecognizing] = useState(false);
  /** 卡片详情里翻看新旧卡面：0 = 当前卡面，1.. = 旧卡面 */
  const [faceIndex, setFaceIndex] = useState(0);

  const [active, setActive] = useState<CardEntry | null>(null);
  const [draft, setDraft] = useState({ amount: "", currency: "CNY", note: "" });
  const [saving, setSaving] = useState(false);
  const [userTags, setUserTags] = useState<Record<string, string[]>>(() => initial?.tags ?? {});
  const [tagDraft, setTagDraft] = useState("");
  /** 「+」点开后原地变成输入框（回车 / 失焦保存，Esc 取消） */
  const [tagInputOpen, setTagInputOpen] = useState(false);
  /** 自定义卡面正在上传 / 保存 */
  const [coverSaving, setCoverSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 卡背信息（卡号 / 有效期 / 安全码 / 备注 / 币种）与卡包叠卡视图 */
  const [details, setDetails] = useState<Record<string, CardDetails>>(() => initial?.details ?? {});
  /** 卡面覆盖表（素材库「卡片」类目里的图；没登记的卡回退清单原图） */
  const [covers, setCovers] = useState<Record<string, string>>(() => initial?.covers ?? {});
  /** 用户自建的卡（素材库里没有的）：并进卡面库一起显示 */
  const [customCards, setCustomCards] = useState<CustomCard[]>(() => initial?.customCards ?? []);
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
    firstSeen?: unknown;
    details?: unknown;
    covers?: unknown;
    customCards?: unknown;
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
    setFirstSeen(data.firstSeen && typeof data.firstSeen === "object" ? (data.firstSeen as Record<string, string>) : {});
    setDetails(data.details && typeof data.details === "object" ? (data.details as Record<string, CardDetails>) : {});
    setCovers(data.covers && typeof data.covers === "object" ? (data.covers as Record<string, string>) : {});
    setCustomCards(Array.isArray(data.customCards) ? (data.customCards as CustomCard[]) : []);
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

  /**
   * 把用户自建的卡并进清单（同一个地区 / 银行下合并），之后所有筛选、卡片详情、
   * 卡包、余额历史都走和清单卡完全一样的逻辑。
   */
  const mergedRegions = useMemo(() => {
    const merged: RegionEntry[] = regions.map((entry) => ({
      label: entry.label,
      // 与另一张完全重复的素材（同图不同格式）不展示；同一张卡的新旧卡面并成一条
      banks: entry.banks.map((bank) => ({
        ...bank,
        cards: bank.cards
          // 旧卡面 / 重复素材都不再单列：旧卡面改成在主卡详情里翻面看
          .filter((card) => !CARD_VARIANT_MERGED.has(card.file))
          .map((card) => {
            const others = CARD_VARIANT_FACES[card.file];
            const mergeKeys = CARD_VARIANT_MERGE_KEYS[card.file];
            if (!others && !mergeKeys) return card;
            // 显示顺序固定：当前卡面在前、旧卡面在后（详情页翻面用）；
            // 但「持有 / 金额 / 标签」的 key 可能记在任意一版上，所以单独挑一个有数据的当数据键，
            // 免得合并之后变成"未加入我的卡"。
            const keys = mergeKeys ?? [card.file];
            const dataKey = keys.find((key) => holdings[key] || amounts[key]) ?? card.file;
            const faces = [
              { file: card.file, label: "当前卡面" },
              ...(others ?? []).map((item) => ({ file: item.file, label: item.label }))
            ];
            return {
              ...card,
              // 名字里的 (新) / (Old) 这类版本标记不必再显示
              name: card.name.replace(/\s*[（(]\s*(?:新|新卡|old|new)\s*[)）]\s*$/i, "").trim() || card.name,
              file: dataKey,
              faces
            };
          })
      }))
    }));
    // 自建卡（素材库里没有的）并进同一个地区 / 银行
    customCards.forEach((card) => {
      const regionLabel = card.region || "未分类";
      let regionEntry = merged.find((entry) => entry.label === regionLabel);
      if (!regionEntry) {
        regionEntry = { label: regionLabel, banks: [] };
        merged.push(regionEntry);
      }
      const folder = `custom:${card.bank || "自定义银行"}`;
      let bankEntry = regionEntry.banks.find((bank) => bank.folder === folder);
      if (!bankEntry) {
        bankEntry = { name: card.bank || "自定义银行", englishName: "", country: "", folder, cards: [] };
        regionEntry.banks.push(bankEntry);
      }
      bankEntry.cards.push({
        name: card.name,
        type: card.type || "其他",
        // 自建卡的卡面是上传后的地址（/uploads/...），直接当 file 用
        file: card.image,
        brand: card.brand,
        level: card.level,
        custom: true,
        customId: card.id,
        createdAt: card.createdAt
      });
    });
    return merged;
  }, [regions, customCards, holdings, amounts]);

  const flat = useMemo(() => {
    const list: CardEntry[] = [];
    mergedRegions.forEach((entry) => {
      entry.banks.forEach((bank) => {
        bank.cards.forEach((card) => list.push({ card, bank, region: entry.label, tags: cardTagsOf(card.name) }));
      });
    });
    return list;
  }, [mergedRegions]);

  /** 地区排序：先按洲，中国各地优先，再按卡面数量 */
  const sortedRegions = useMemo(() => {
    const cardCount = (entry: RegionEntry) => entry.banks.reduce((sum, bank) => sum + bank.cards.length, 0);
    return [...mergedRegions].sort((a, b) => {
      const ca = CONTINENT_ORDER.indexOf((REGION_CONTINENT[a.label] ?? "其他") as (typeof CONTINENT_ORDER)[number]);
      const cb = CONTINENT_ORDER.indexOf((REGION_CONTINENT[b.label] ?? "其他") as (typeof CONTINENT_ORDER)[number]);
      if (ca !== cb) return ca - cb;
      const chinaA = CHINA_REGIONS.has(a.label) ? 0 : 1;
      const chinaB = CHINA_REGIONS.has(b.label) ? 0 : 1;
      if (chinaA !== chinaB) return chinaA - chinaB;
      return cardCount(b) - cardCount(a) || a.label.localeCompare(b.label, "zh-Hans-CN");
    });
  }, [mergedRegions]);

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
  /** 搜索关键词：繁转简 + 去空格（港台卡名是繁体，输简体也要搜得到） */
  const keyword = searchKey(query);

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
    if (!keyword) return true;
    // 卡名 / 银行 / 卡组织 / 主题标签一起当搜索源，统一繁转简后再比对
    const haystack = searchKey([card.name, bank.name, bank.englishName || "", card.brand || "", tags.join(" ")].join(" "));
    return haystack.includes(keyword);
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

  /** 「更多筛选」里选中的维度数：手机收起时用角标提示"有筛选生效" */
  const detailFilterCount =
    region.length + bankFolder.length + brand.length + level.length + tag.length + myTag.length + (scopeFilter ? 1 : 0);

  /** 「筛选」按钮上的角标：生效的筛选维度数（类型也算一个） */
  const activeFilterCount = detailFilterCount + (type ? 1 : 0);

  /** 清空全部筛选（类型胶囊、下拉筛选、搜索词一起还原） */
  const resetFilters = () => {
    setType("");
    setRegion([]);
    setBankFolder([]);
    setBrand([]);
    setLevel([]);
    setTag([]);
    setMyTag([]);
    setScopeFilter("");
    setQuery("");
  };

  /**
   * 已生效的筛选条件：工具栏下面用一排可点掉的胶囊列出来 ——
   * 只看「筛选 3」这样的角标，用户没法知道到底是哪 3 个条件在起作用，也没法单独去掉某一个。
   */
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (query.trim()) activeFilters.push({ key: "query", label: `搜索「${query.trim()}」`, clear: () => setQuery("") });
  if (type) activeFilters.push({ key: "type", label: `类型 ${type}`, clear: () => setType("") });
  if (scopeFilter) activeFilters.push({ key: "scope", label: `币种 ${scopeFilter}`, clear: () => setScopeFilter("") });
  region.forEach((value) =>
    activeFilters.push({ key: `region:${value}`, label: `地区 ${value}`, clear: () => setRegion((prev) => prev.filter((item) => item !== value)) })
  );
  bankFolder.forEach((value) =>
    activeFilters.push({
      key: `bank:${value}`,
      label: `银行 ${bankSelectOptions.find((option) => option.value === value)?.label.split(" ")[0] ?? value}`,
      clear: () => setBankFolder((prev) => prev.filter((item) => item !== value))
    })
  );
  brand.forEach((value) => activeFilters.push({ key: `brand:${value}`, label: `卡组织 ${value}`, clear: () => setBrand((prev) => prev.filter((item) => item !== value)) }));
  level.forEach((value) => activeFilters.push({ key: `level:${value}`, label: `等级 ${value}`, clear: () => setLevel((prev) => prev.filter((item) => item !== value)) }));
  tag.forEach((value) => activeFilters.push({ key: `tag:${value}`, label: `主题 ${value}`, clear: () => setTag((prev) => prev.filter((item) => item !== value)) }));
  myTag.forEach((value) => activeFilters.push({ key: `myTag:${value}`, label: `我的标签 ${value}`, clear: () => setMyTag((prev) => prev.filter((item) => item !== value)) }));

  /** Esc 关掉筛选面板与显示方式菜单：键盘操作时不用去点空白处 */
  useEffect(() => {
    if (!filtersOpen && !scriptMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFiltersOpen(false);
      setScriptMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtersOpen, scriptMenuOpen]);

  /** 筛选条件变化时回到第一屏 */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE_FIRST);
  }, [region.join(","), bankFolder.join(","), type, brand.join(","), level.join(","), tag.join(","), myTag.join(","), scopeFilter, query]);

  /** 卡片详情弹窗：手机上锁住背景滚动，Esc 关闭 */
  useEffect(() => {
    if (!active && !addOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (addOpen) setAddOpen(false);
      else setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [active, addOpen]);

  /** 新增卡片弹窗打开时：图片拖到窗口任何位置都别让浏览器直接打开它（只有卡面框接住） */
  useEffect(() => {
    if (!addOpen) return;
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, [addOpen]);

  /** 切「我的卡 / 全部卡面」时，如果已经滑到列表深处，轻轻带回卡面库顶部 */
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const top = node.getBoundingClientRect().top;
    if (top < -140) window.scrollTo({ top: Math.max(0, window.scrollY + top - 12), behavior: "smooth" });
  }, [mode]);

  /** 手机上滑过一屏之后浮出「回到顶部」 */
  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 480);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * 时间戳：判断 NEW 角标是否还在 3 天内、以及新加的卡要不要置顶。
   * 首帧优先用**服务端注入的时间**（initial.nowMs）——判断依据两边一致，
   * 服务端渲染出来就是最终顺序，刷新不会"先按默认顺序画一遍、挂载后卡片跳到最前"。
   * 没有首屏注入时（如本地直连接口）挂载后补一次；之后每小时校准，角标到点自动消失。
   * 注意：必须声明在 sortedItems 之前 —— 排序里读它，写在后面会踩 TDZ 报错。
   */
  const [nowMs, setNowMs] = useState<number>(() => initial?.nowMs ?? 0);
  useEffect(() => {
    if (!initial?.nowMs) setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60 * 60 * 1000);
    return () => window.clearInterval(timer);
    // 只在挂载时跑一次：initial 是首屏注入的静态数据，不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 按当前排序方式排好的列表（同分保持清单顺序，避免每次刷新乱跳） */
  const sortedItems = useMemo(() => {
    if (sort === "default") {
      // 默认顺序：把 3 天内**新入库**的卡排到最上面（脚本导入的新卡 / 自己新建的卡，
      // 和 NEW 角标同一套判断）；其余（含刚加入我的卡的素材库旧卡）保持清单顺序
      const list = filtered.map((entry, index) => ({ entry, index, at: firstSeenStampOf(entry.card, firstSeen) }));
      const pinned = list.filter((item) => nowMs > 0 && item.at > 0 && nowMs - item.at < NEW_CARD_MS);
      if (pinned.length === 0) return filtered;
      pinned.sort((a, b) => b.at - a.at || a.index - b.index);
      const pinnedFiles = new Set(pinned.map((item) => item.entry.card.file));
      return [
        ...pinned.map((item) => item.entry),
        ...list.filter((item) => !pinnedFiles.has(item.entry.card.file)).map((item) => item.entry)
      ];
    }
    const list = filtered.map((entry, index) => ({ entry, index }));
    list.sort((a, b) => {
      if (sort === "name") {
        const diff = cardTitle(a.entry.card.name, script).localeCompare(cardTitle(b.entry.card.name, script), "zh-Hans-CN");
        if (diff !== 0) return diff;
      } else {
        const diff =
          bankTitle(a.entry.bank, script).localeCompare(bankTitle(b.entry.bank, script), "zh-Hans-CN") ||
          cardTitle(a.entry.card.name, script).localeCompare(cardTitle(b.entry.card.name, script), "zh-Hans-CN");
        if (diff !== 0) return diff;
      }
      return a.index - b.index;
    });
    return list.map((item) => item.entry);
  }, [filtered, sort, script, nowMs, firstSeen]);

  const pageItems = useMemo(() => sortedItems.slice(0, visibleCount), [sortedItems, visibleCount]);


  /**
   * 分页是「点一下加载一批」：不做滑到底自动续加 ——
   * 自动加载会把「加载更多」按钮一路往下推，用户滚到底只看到卡片自己冒出来，
   * 反而以为列表没加载完 / 找不到加载入口。
   */
  const activeUserTags = active ? userTags[active.card.file] ?? [] : [];
  const activeScope = active ? scopeByCard[active.card.file] : undefined;
  /** 详情页可翻的卡面：当前卡面 + 同一张卡的旧卡面（来自 lib/cardVariants 的合并表） */
  const activeFaces = active ? active.card.faces ?? [{ file: active.card.file, label: "当前卡面" }] : [];
  const activeFace = activeFaces[Math.min(faceIndex, Math.max(0, activeFaces.length - 1))];
  useEffect(() => {
    setFaceIndex(0);
  }, [active?.card.file]);
  /** 币种下拉的选项：按这张卡的币种范围收窄（单币 1 个、双币 2 个、多币种给该地区常见币种） */
  const activeCurrencyOptions = active
    ? cardCurrencyChoicesFor({
        name: active.card.name,
        brand: active.card.brand,
        bank: active.bank.name,
        region: active.region,
        currencyScope: details[active.card.file]?.currencyScope,
        current: draft.currency
      })
    : [];

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
            name: cardTitle(card.name, script),
            bank: bankTitle(bank, script),
            region: regionLabel,
            type: card.type || "",
            brand: card.brand || "",
            level: card.level || "",
            image: card.file,
            cover: (() => {
              // 有多版卡面时，卡包展示的是最新那一版
              const shown = card.faces?.[0]?.file ?? card.file;
              // 同 cardCover：覆盖表优先，自建卡也不要直接绕过
              if (covers[shown]) return covers[shown];
              return shown.startsWith("/") ? shown : manifestCoverUrl(shown);
            })(),
            amount: saved?.amount ?? 0,
            currency: saved?.currency || info?.currency || REGION_CURRENCY[regionLabel] || "CNY",
            hasAmount: !!saved,
            number: info?.number || "",
            expiry: info?.expiry || "",
            cvv: info?.cvv || "",
            note: info?.note || "",
            // 币种范围的手动覆盖：卡包里改币种时也要按同一份规则收窄选项
            currencyScope: info?.currencyScope || ""
          };
        }),
    [flat, holdings, amounts, details, covers, script]
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

  /** 卡面实际展示地址：素材库里换过图就用那条素材的 url，否则回退清单原图 */
  function cardCover(cardFile: string) {
    // 换过图（素材库里那条 card:{卡面} 的 url）优先 —— 自建卡也一样：
    // 它的卡面地址本身就是 /uploads/...，以前直接 return 会绕过覆盖表，
    // 于是给自建卡重新上传卡面后界面还是旧图（"上传成功但不生效"就是这里）。
    if (covers[cardFile]) return covers[cardFile];
    // 自建卡没换过图时，卡面地址本身就是最终地址，直接用
    return cardFile.startsWith("/") ? cardFile : manifestCoverUrl(cardFile);
  }

  /** 这张卡是不是换过图（判断依据是素材库里的 url 与清单原图不同） */
  function hasCustomCover(cardFile: string) {
    const url = covers[cardFile];
    // 自建卡（卡面地址本身就是 /uploads/...）没有「清单原图」，
    // 拿清单地址去比永远不相等，会一直显示「恢复原图」按钮 —— 它的原图就是创建时那张
    if (cardFile.startsWith("/")) return Boolean(url && url !== cardFile);
    return Boolean(url && url !== manifestCoverUrl(cardFile));
  }

  /**
   * 上传自定义卡面：文件先传到素材目录（folder=card），再写进**素材库的卡片素材**
   * （`card:{卡面文件}`，即素材库 →「卡片」里那一条）。所以这里换的图和素材库里换的是同一份，
   * 全站生效，不会出现「两处各管一份」。
   */
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
      if (!(await saveCardAsset(entry, url))) return;
      setCovers((prev) => ({ ...prev, [entry.card.file]: url }));
      showToast("卡面已更新（素材库·卡片里也是这一张）");
    } catch {
      showToast("上传失败，稍后再试", "err");
    } finally {
      setCoverSaving(false);
    }
  }

  /** 写素材库里这张卡的素材（id 固定为 card:{卡面文件}），返回是否成功 */
  async function saveCardAsset(entry: CardEntry, url: string) {
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: cardAssetId(entry.card.file),
        type: "card",
        market: entry.region,
        code: entry.card.file.split("/").pop()?.replace(/\.[^.]+$/, "") || entry.card.name,
        name: entry.card.name,
        url
      })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showToast(data?.error || "卡面保存失败，稍后再试", "err");
      return false;
    }
    return true;
  }

  /** 恢复原图：清单卡回到清单里的原图，自建卡回到创建这张卡时上传的那张 */
  async function resetCover(entry: CardEntry) {
    if (coverSaving) return;
    setCoverSaving(true);
    try {
      // 自建卡的 card.file 就是「创建时那张图」的地址（/uploads/...）；
      // 之前这里一律套 manifestCoverUrl，等于拼出 /uploads/cards//uploads/... 这种不存在的地址，
      // 于是恢复原图之后图片直接 404 变成裂图。
      const original = entry.card.file.startsWith("/") ? entry.card.file : manifestCoverUrl(entry.card.file);
      if (!(await saveCardAsset(entry, original))) return;
      setCovers((prev) => ({ ...prev, [entry.card.file]: original }));
      showToast(entry.card.file.startsWith("/") ? "已恢复这张卡最初上传的卡面" : "已恢复清单原图");
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
    // 币种只在「这张卡能记的币种」里选：单币卡就那一个（老数据里币种不合法的顺手纠正）
    const choices = cardCurrencyChoicesFor({
      name: entry.card.name,
      brand: entry.card.brand,
      bank: entry.bank.name,
      region: entry.region,
      currencyScope: details[entry.card.file]?.currencyScope,
      current: saved?.currency || details[entry.card.file]?.currency || ""
    });
    const preferred = saved?.currency || details[entry.card.file]?.currency || REGION_CURRENCY[entry.region] || "CNY";
    setDraft({
      amount: saved ? String(saved.amount) : "",
      currency: choices.includes(preferred) ? preferred : choices[0] ?? "CNY",
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

  /** 新增卡片：先把卡面传到素材目录（folder=card），拿到 /uploads/... 地址 */
  async function uploadNewImage(file: File) {
    if (newUploading) return;
    if (!file.type.startsWith("image/")) {
      showToast("只能上传图片文件（JPG / PNG / WEBP）", "err");
      return;
    }
    // 服务端卡面上传上限 20MB，这里先拦一道，省得白传一次
    if (file.size > 20 * 1024 * 1024) {
      showToast(`这张图 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限`, "err");
      return;
    }
    setNewUploading(true);
    try {
      const form = new FormData();
      form.append("kind", "asset");
      form.append("folder", "card");
      form.append("file", file);
      form.append("name", newCard.name || file.name.replace(/\.[^.]+$/, "") || "自定义卡面");
      form.append("code", newCard.region || "CARD");
      const res = await fetch("/api/v1/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      const url: string | undefined = data?.data?.url ?? data?.url;
      if (!res.ok || !url) {
        showToast(data?.message || data?.error || "上传失败，稍后再试", "err");
        return;
      }
      setNewImage(url);
      void recognizeNewImage(url);
    } catch {
      showToast("上传失败，稍后再试", "err");
    } finally {
      setNewUploading(false);
    }
  }

  /**
   * 卡面识别：把刚上传的图片交给 DeepSeek 读卡名 / 银行 / 地区 / 类型 / 卡组织 / 等级，
   * 只填空着的字段（用户已经填过的不覆盖）。没配 Key / 识别失败就静默跳过。
   */
  async function recognizeNewImage(url: string) {
    setRecognizing(true);
    try {
      const res = await fetch("/api/cards/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: url })
      });
      const data = res.ok ? await res.json() : null;
      const card = data?.card as
        | { name?: string; bank?: string; region?: string; type?: string; brand?: string; level?: string }
        | null
        | undefined;
      if (!card) return;
      const patch: Partial<typeof newCard> = {};
      if (card.name && !newCard.name.trim()) patch.name = card.name;
      if (card.bank && !newCard.bank.trim()) patch.bank = card.bank;
      if (card.brand && !newCard.brand.trim()) patch.brand = card.brand;
      if (card.level && !newCard.level.trim()) patch.level = card.level;
      if (card.type && CARD_TYPE_OPTIONS.includes(card.type)) patch.type = card.type;
      if (card.region && REGION_CURRENCY[card.region]) patch.region = card.region;
      const filled = Object.keys(patch).length;
      if (filled > 0) setNewCard((prev) => ({ ...prev, ...patch }));
      showToast(filled > 0 ? `已识别并自动填入 ${filled} 项，请核对` : "识别完成，字段请手动补充");
    } catch {
      /* 识别失败不打扰用户，手填即可 */
    } finally {
      setRecognizing(false);
    }
  }

  /** 保存自建卡：写库 + 登记素材库 → 直接并进卡面库（自动进「我的卡」） */
  async function submitNewCard() {
    if (!newImage) {
      showToast("请先上传卡面图片", "err");
      return;
    }
    if (!newCard.name.trim() || !newCard.bank.trim()) {
      showToast("请填写卡名和银行", "err");
      return;
    }
    // 库里已经有的卡（同名 + 同银行）不用再建一张
    const duplicate = flat.find(
      ({ card, bank }) => searchKey(card.name) === searchKey(newCard.name) && searchKey(bank.name) === searchKey(newCard.bank)
    );
    if (duplicate) {
      showToast(`「${newCard.bank} ${newCard.name}」已经在卡面库里了`, "err");
      return;
    }
    if (newSaving) return;
    setNewSaving(true);
    try {
      const res = await fetch("/api/cards/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newCard, name: newCard.name.trim(), bank: newCard.bank.trim(), image: newImage })
      });
      const data = res.ok ? await res.json() : null;
      if (!res.ok || !data?.card) throw new Error("save failed");
      const card = data.card as CustomCard;
      setCustomCards((prev) => [...prev, card]);
      // 新建的卡只进「全部卡面」，需要时再自己点「＋ 加入」收进我的卡
      if (mode !== "all") setMode("all");
      showToast(`已新增卡片：${card.name}——在「全部卡面」里，点「＋ 加入」可收进我的卡`);
      setAddOpen(false);
      setNewCard({ name: "", bank: "", region: "中国内地", type: "借记卡", brand: "", level: "", currencyScope: "single" });
      setNewImage("");
    } catch {
      showToast("保存失败，稍后再试", "err");
    } finally {
      setNewSaving(false);
    }
  }

  /** 删除自建卡（卡片 + 素材库里那条卡面素材一起清掉） */
  async function removeCustomCard(entry: CardEntry) {
    const id = entry.card.customId;
    if (!id || saving) return;
    if (!window.confirm("删除这张自定义卡片？它上传的卡面素材也会从素材库里移除。")) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cards/custom?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      setCustomCards((prev) => prev.filter((card) => card.id !== id));
      showToast("已删除这张卡片");
      setActive(null);
    } catch {
      showToast("删除失败，稍后再试", "err");
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
        {/* 模式切换（分段控件）是主角，新增卡片 / 卡包缩成两枚图标按钮跟在后面：一排放下，少两个大按钮 */}
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-full border border-edge bg-white p-1 sm:w-auto sm:flex-none dark:border-white/10 dark:bg-[#1c222d]">
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
          <div className="flex flex-none items-center gap-2">
            {/* 新增卡片：素材库里没有的卡自己传卡面加进来，点开是弹窗 */}
            <button
              type="button"
              onClick={() => {
                setAddOpen(true);
              }}
              title="新增卡片：素材库里没有的卡，可以自己传卡面加进来"
              aria-label="新增卡片"
              className="grid h-10 w-10 flex-none place-items-center rounded-full border border-edge bg-white text-ink-2 transition-all duration-200 hover:-translate-y-px hover:border-edge-strong hover:bg-brand-hover hover:text-ink dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setWalletOpen(true)}
              title="打开卡包：堆叠浏览卡片、翻到卡背看有效期与安全码、记录余额历史"
              aria-label="打开卡包"
              className="grid h-10 w-10 flex-none place-items-center rounded-full border border-edge bg-white text-ink-2 transition-all duration-200 hover:-translate-y-px hover:border-edge-strong hover:bg-brand-hover hover:text-ink dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                <rect x="4" y="8" width="15" height="10" rx="2.4" />
                <path d="M7.4 5.6h12.2a1.8 1.8 0 0 1 1.8 1.8v7.2" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* 搜索：独立一行；手机上高度给到 44px，输入后右侧出现清空按钮 */}
      <div className="flex w-full flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[520px] flex-1">
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
        {/* 筛选：币种范围 / 地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签都收在这一个按钮后面 */}
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          title="筛选：币种范围 / 地区 / 银行 / 卡组织 / 等级 / 主题 / 我的标签"
          className={`inline-flex h-11 flex-none items-center gap-1.5 rounded-xl border bg-white px-3 text-[13px] font-semibold transition-colors duration-200 sm:h-10 dark:bg-[#1c222d] ${
            filtersOpen ? "border-edge-strong text-ink dark:text-white" : "border-edge text-ink-2 hover:border-edge-strong dark:text-white/80"
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-none text-muted">
            <path d="M4 5h16l-6.4 7.6v5.3L10.4 20v-7.4z" />
          </svg>
          筛选
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-[#3297f6] px-1.5 py-0.5 text-[10px] font-bold text-white">{activeFilterCount}</span>
          )}
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3.5 w-3.5 flex-none text-faint transition-transform duration-200 ${filtersOpen ? "rotate-180" : ""}`}
          >
            <path d="m5 7 5 5 5-5" />
          </svg>
        </button>
        {/* 排序：默认顺序 / 按卡名 / 按银行（记住选择）。
            图标用「由长到短的横线 + 下箭头」，比原来的上下箭头干净；下拉箭头自绘，去掉浏览器默认那一枚 */}
        <label className="flex h-11 items-center gap-1.5 rounded-xl border border-edge bg-white pl-3 pr-2.5 transition-colors duration-200 hover:border-edge-strong sm:h-10 dark:bg-[#1c222d]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-none text-muted">
            <path d="m3 16 4 4 4-4" />
            <path d="M7 20V4" />
            <path d="M11 4h4" />
            <path d="M11 8h7" />
            <path d="M11 12h10" />
          </svg>
          <span className="relative flex items-center">
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as LibrarySort);
                setVisibleCount(PAGE_SIZE_FIRST);
              }}
              aria-label="排序方式"
              className="appearance-none bg-transparent pr-4 text-[13px] font-semibold text-ink outline-none dark:text-white"
            >
              {(Object.keys(LIBRARY_SORT_LABEL) as LibrarySort[]).map((key) => (
                <option key={key} value={key}>
                  {LIBRARY_SORT_LABEL[key]}
                </option>
              ))}
            </select>
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none absolute right-0 h-3.5 w-3.5 text-faint"
            >
              <path d="m5 7 5 5 5-5" />
            </svg>
          </span>
        </label>
      </div>

      {/* 已生效的筛选：工具栏下面排一行，点胶囊单独去掉，右边一键全清 */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold text-faint">已筛选</span>
          {activeFilters.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.clear}
              title="点一下去掉这个条件"
              className="inline-flex items-center gap-1 rounded-full border border-edge bg-white px-2.5 py-1 text-[11px] font-semibold text-ink-2 transition-colors duration-200 hover:border-edge-strong hover:bg-brand-hover hover:text-ink dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
            >
              {item.label}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-3 w-3 flex-none text-faint">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          ))}
          <button
            type="button"
            onClick={resetFilters}
            className="ml-0.5 rounded-full px-2 py-1 text-[11px] font-semibold text-[#2f6fed] transition-colors duration-200 hover:bg-brand-hover dark:hover:bg-white/10"
          >
            全部清空
          </button>
        </div>
      )}

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
                  {typeTitle(label, script)} <b className="tabular-nums text-ink-2">{count}</b>
                </span>
              ))}
            </span>
            {/* 手机：三个合计排成两列，不再挤成一行再换行 */}
            <span className="grid w-full grid-cols-2 gap-x-4 gap-y-1.5 sm:ml-auto sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
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
            <div className="ticker-scroll flex flex-wrap items-center gap-1.5 border-t border-edge pt-2 max-sm:flex-nowrap max-sm:overflow-x-auto">
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
        {/* 类型胶囊 + 显示方式同一行：胶囊横向滑动，显示方式钉在右边（这一行本来右边就是空的） */}
        <div className="flex items-center gap-2">
          <div className="ticker-scroll -mx-3 min-w-0 flex-1 overflow-x-auto overscroll-x-contain px-3 max-sm:[mask-image:linear-gradient(to_right,#000_92%,transparent)] sm:mx-0 sm:overflow-visible sm:px-0">
            <PillGroup
              label="类型"
              options={typeOptions}
              values={type ? [type] : []}
              onToggle={(key) => setType((prev) => (prev === key ? "" : key))}
              onClear={() => setType("")}
            />
          </div>
          {/* 显示方式（原文 / 简体 / 繁體 / 英文）：四个档位收进这个小菜单，按钮上只显示当前档位 */}
          <div className="relative flex-none">
            <button
              type="button"
              onClick={() => setScriptMenuOpen((open) => !open)}
              aria-expanded={scriptMenuOpen}
              aria-haspopup="menu"
              aria-label={`显示方式：当前「${currentScript.label}」`}
              title="切换显示：原文 / 简体 / 繁體 / 英文（只影响显示，不改数据）"
              className={`inline-flex h-10 items-center gap-1.5 rounded-full border bg-white px-3 text-[12px] font-semibold transition-colors duration-200 sm:h-9 dark:bg-[#1c222d] ${
                scriptMenuOpen ? "border-edge-strong text-ink dark:text-white" : "border-edge text-ink-2 hover:border-edge-strong dark:text-white/80"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-none text-muted">
                <path d="M2 5h12" />
                <path d="M7 2h1" />
                <path d="m5 8 6 6" />
                <path d="m4 14 6-6 2-3" />
                <path d="m22 22-5-10-5 10" />
                <path d="M14 18h6" />
              </svg>
              <span className="min-w-[2.6em] text-left">{currentScript.label}</span>
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`h-3.5 w-3.5 flex-none text-faint transition-transform duration-200 ${scriptMenuOpen ? "rotate-180" : ""}`}
              >
                <path d="m5 7 5 5 5-5" />
              </svg>
            </button>
            {scriptMenuOpen && (
              <>
                {/* 点空白处关掉菜单（和筛选下拉同一套做法） */}
                <div className="fixed inset-0 z-[60]" onClick={() => setScriptMenuOpen(false)} />
                <div
                  role="menu"
                  aria-label="显示方式"
                  className="absolute right-0 top-full z-[70] mt-1 w-44 overflow-hidden rounded-xl border border-edge-strong bg-white p-1 shadow-pop dark:border-white/10 dark:bg-[#1b2029]"
                >
                  {SCRIPT_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={script === option.value}
                      onClick={() => {
                        setScript(option.value);
                        setScriptMenuOpen(false);
                      }}
                      title={option.hint}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold transition-colors duration-150 ${
                        script === option.value
                          ? "bg-brand-hover text-ink dark:bg-white/10 dark:text-white"
                          : "text-ink-2 hover:bg-brand-hover dark:text-white/80 dark:hover:bg-white/10"
                      }`}
                    >
                      <span>{option.label}</span>
                      {script === option.value && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-none text-[#2f6fed]">
                          <path d="m5 13 4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        {/* 7 个下拉：默认收起（工具栏的「筛选」按钮展开），lg（1024px）往上刚好能排成一排，
            再窄就退成 4 列 / 2 列，避免挤到看不清 */}
        {filtersOpen && (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-7">
          {/* 币种范围（单币 / 双币 / 多币种）放在下拉这一排：和地区、银行同级，
              不再和「类型」各占一排胶囊抢注意力 */}
          <MultiSelect
            single
            label="币种范围"
            allLabel="全部币种"
            values={scopeFilter ? [scopeFilter] : []}
            options={scopeOptions.slice(1).map((option) => ({
              value: option.key,
              label: `${option.key}（${option.count}）`,
              // 和卡片角标同色的小圆点：单币绿 / 双币蓝 / 多币种紫 / 待确认琥珀
              icon: (
                <span
                  aria-hidden
                  className={`h-2 w-2 flex-none rounded-full ${SCOPE_DOT_CLASS[scopeOfLabel(option.key)]}`}
                />
              )
            }))}
            onChange={(next) => setScopeFilter(next[0] ?? "")}
          />
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
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted">{mode === "mine" ? "持有的卡里没有符合条件的卡面" : "没有符合条件的卡面"}</p>
          {/* 条件挡住了卡片：直接给一个出口，不用自己去回想点过哪些筛选 */}
          {activeFilters.length > 0 && (
            <button
              type="button"
              onClick={resetFilters}
              className="h-11 rounded-full border border-edge-strong bg-white px-5 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover sm:h-9 sm:px-4 dark:bg-[#1c1c1e] dark:text-white"
            >
              清空全部筛选
            </button>
          )}
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
                translate="no"
                onClick={() => openCard({ card, bank, region: regionLabel, tags })}
                className="notranslate group flex flex-col overflow-hidden rounded-2xl border border-edge bg-white text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-pop active:scale-[.995] [contain-intrinsic-size:auto_190px] [content-visibility:auto] dark:bg-[#16181d]"
              >
                {/* 卡片底托：留白 + 圆角裁切，让每张卡看起来都像一张实体卡（素材自带圆角的也保持一致） */}
                <span className="block w-full bg-bg-gray/60 p-2.5 dark:bg-white/[0.04]">
                  <span className="relative block overflow-hidden rounded-[10px] bg-bg-gray shadow-sm ring-1 ring-black/5 dark:bg-white/5 dark:ring-white/10">
                      <img
                        src={cardCover(card.faces?.[0]?.file ?? card.file)}
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
                    {isFreshEntry(card, firstSeen, nowMs) && (
                      <span className="absolute left-2 top-2 flex items-center gap-1">
                        {/* 只有 3 天内新入库的卡挂 NEW（脚本导入的新卡 / 自己新建的卡）；刚加入我的卡不算 */}
                        <span className="rounded-full bg-black/35 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#fbbf24] ring-1 ring-inset ring-white/20 backdrop-blur-sm">
                          new
                        </span>
                      </span>
                    )}
                    {/*
                      右下角一颗圆形胶囊同时承担「状态 + 操作」：
                        ✓ = 已经在我的卡里，＋ = 还没加入；点一下切换。
                      「全部卡面」里每张卡的状态不同 → ✓/＋ 常显，一眼能扫出哪些已经有了；
                      「我的卡」里每张都是自己的，✓ 恒为真、没有信息量，所以鼠标端只划过才浮出
                      （触屏没有 hover，仍然常显 —— 否则没法移除），展开成「✓ 移出 / ＋ 加入」，
                      所以不再需要原生 title —— 那个提示要等一秒多才出来，正是你说的「有延迟」。
                    */}
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        void setHeld(card.file, !isHeld);
                      }}
                      aria-label={isHeld ? "移出我的卡" : "加入我的卡"}
                      /* 手机端可见直径 24px、热区靠 after 外扩到 44px（视觉更轻，手指仍然好点）；
                         桌面端恢复成带文字的胶囊（默认只留 ✓/＋，划过卡片才展开文字） */
                      className={`absolute bottom-1.5 right-1.5 inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-full text-[12px] font-bold shadow-sm transition-all duration-200 after:absolute after:-inset-2.5 after:content-[''] active:scale-95 sm:bottom-2 sm:right-2 sm:h-auto sm:w-auto sm:px-2 sm:text-[11px] sm:font-semibold ${
                        mode === "mine" ? "touch-always opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : ""
                      } ${
                        isHeld ? "bg-white/90 text-[#2f6fed]" : "bg-white/90 text-ink-2 hover:bg-white"
                      }`}
                    >
                      <span className="flex-none">{isHeld ? "✓" : "＋"}</span>
                      <span className="pointer-only inline-block max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 group-hover:max-w-[3.4rem] group-hover:pl-1 group-hover:opacity-100">
                        {isHeld ? "移出" : "加入"}
                      </span>
                    </span>
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                  <b className="truncate text-[13px] font-semibold text-ink">{cardTitle(card.name, script)}</b>
                  <small className="truncate text-[11px] text-muted">
                    {bankTitle(bank, script)}
                    {card.brand ? ` · ${card.brand}` : ""}
                    {card.level ? ` · ${card.level}` : ""}
                  </small>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <i
                      title={currencyScopeSummary(scopeByCard[card.file]?.info ?? { scope, currencies: [], reason: "", confidence: "low" })}
                      className={`inline-flex items-center rounded-full px-2 py-[3px] text-[10px] font-semibold not-italic sm:px-1.5 sm:py-[2px] sm:text-[9px] ${SCOPE_CHIP_CLASS[scope]}`}
                    >
                      {CURRENCY_SCOPE_LABEL[scope]}
                    </i>
                    {/* 多版卡面标识：叠卡图标 + 版数，鼠标悬停说明「打开可以翻面」 */}
                    {/* faces 本身包含当前卡面，所以 >1 才是「多版」 */}
                    {(card.faces?.length ?? 0) > 1 && (
                      <i
                        title={`这张卡有 ${card.faces?.length ?? 0} 版卡面（新 / 旧），打开可以翻面看`}
                        className="inline-flex items-center gap-1 rounded-full bg-ink/[0.06] px-2 py-[3px] text-[10px] font-semibold not-italic text-ink-2 sm:px-1.5 sm:py-[2px] sm:text-[9px] dark:bg-white/10 dark:text-white/75"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                          <rect x="3" y="8" width="13" height="9" rx="2" />
                          <path d="M7 5h11a2 2 0 0 1 2 2v8" />
                        </svg>
                        {card.faces?.length ?? 0} 版
                      </i>
                    )}
                    {shownTags.slice(0, 3).map((item) => (
                        <i
                          key={item}
                          className={`inline-flex items-center rounded-full px-2 py-[3px] text-[10px] font-semibold not-italic sm:px-1.5 sm:py-[2px] sm:text-[9px] ${
                            mine.includes(item)
                              ? "bg-[#3b82f6]/10 text-[#1e40af] dark:bg-[#3b82f6]/14 dark:text-[#93c5fd]"
                              : "bg-ink/[0.06] text-ink-2 dark:bg-white/10 dark:text-white/75"
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
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE_STEP)}
            title={`点一下再显示 ${PAGE_SIZE_STEP} 张`}
            className="mx-auto flex h-11 min-w-[180px] items-center justify-center rounded-full bg-[#2f2f2f] px-8 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-[#3d3d3d] active:scale-[.98] dark:bg-white dark:text-[#111] dark:hover:bg-white/90"
          >
            加载更多
          </button>
        )}
        </>
      )}

      {/* 新增卡片：素材库里没有的卡，上传卡面 + 填信息新建（自动进我的卡 + 素材库） */}
      {/* 弹层一律 portal 到 body：挂在应用树里会被祖先的层叠上下文困住，
          z-[10002] 也压不过吸顶页头（z-50），顶部会被页头盖掉。 */}
      {addOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10002] flex items-end justify-center bg-black/60 px-0 pb-0 pt-[72px] sm:items-center sm:px-4 sm:pb-4 sm:pt-[88px]" onClick={() => setAddOpen(false)}>
          <div
            className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-edge bg-white shadow-2xl supports-[height:100dvh]:max-h-[86dvh] sm:rounded-card dark:border-white/10 dark:bg-[#16181d]"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="mx-auto mt-2.5 block h-1 w-10 flex-none rounded-full bg-edge-strong sm:hidden" />
            <div className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3.5 sm:px-5 sm:py-4">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-ink">新增卡片</h3>
                <p className="mt-0.5 text-xs text-muted">
                  素材库里没有的卡：上传卡面 + 填卡片信息，保存后进「全部卡面」，并同步到「素材库 → 卡片」
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                aria-label="关闭"
                className="grid h-10 w-10 flex-none place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2 sm:h-8 sm:w-8"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
              {/* 卡面：点一下选图，上传后本地预览 */}
              <label className="block cursor-pointer">
                <span className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-muted">
                  卡面（必填）
                  {recognizing && <span className="font-normal text-[#2f6fed]">正在识别卡面信息…</span>}
                </span>
                <span
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (!newUploading) setDragActive(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!newUploading) setDragActive(true);
                  }}
                  onDragLeave={(event) => {
                    // 只有真正离开这块区域才取消高亮（移动到子元素上会触发 dragleave）
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    setDragActive(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragActive(false);
                    const file = event.dataTransfer.files?.[0];
                    if (file) void uploadNewImage(file);
                  }}
                  className={`relative block overflow-hidden rounded-xl border border-dashed transition-colors duration-200 ${
                    dragActive ? "border-[#3297f6] bg-[#3297f6]/[0.06]" : "border-edge-strong bg-bg-gray dark:bg-white/5"
                  }`}
                >
                  {newImage ? (
                    <img src={newImage} alt="卡面预览" className="aspect-[1.586] w-full object-cover" />
                  ) : (
                    <span className="flex aspect-[1.586] w-full flex-col items-center justify-center gap-1.5 px-4 text-center">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`h-6 w-6 transition-colors duration-200 ${dragActive ? "text-[#2f6fed]" : "text-muted"}`}
                      >
                        <path d="M12 16V5M8 8.5 12 4.5l4 4M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16" />
                      </svg>
                      <span className={`text-[12px] font-semibold ${dragActive ? "text-[#2f6fed]" : "text-ink-2"}`}>
                        {newUploading ? (
                          "上传中…"
                        ) : dragActive ? (
                          "松手放下这张卡面"
                        ) : (
                          <>
                            <span className="pointer-only">点这里选，或把图片拖进来</span>
                            <span className="touch-only">点这里从相册选一张卡面</span>
                          </>
                        )}
                      </span>
                      <span className="text-[11px] text-faint">建议 1.586:1 标准卡面比例，JPG / PNG / WEBP / SVG，最大 20MB</span>
                      <span className="text-[11px] text-faint">上传后会自动识别卡名 / 银行等信息（图片会发送给 DeepSeek）</span>
                    </span>
                  )}
                  {newImage && !newUploading && (
                    <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">换一张</span>
                  )}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadNewImage(file);
                    }}
                  />
                </span>
              </label>

              {/* 手机：直接调后置摄像头拍一张卡面 */}
              <label className="mt-2 flex h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-edge bg-white text-[12px] font-semibold text-ink-2 transition-colors duration-200 hover:bg-brand-hover sm:hidden dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <path d="M4 8h2.6l1.5-2h7.8l1.5 2H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
                  <circle cx="12" cy="13.5" r="3.2" />
                </svg>
                拍一张卡面
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadNewImage(file);
                  }}
                />
              </label>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="col-span-2 flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">卡名（必填）</span>
                  <input
                    value={newCard.name}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, name: event.target.value }))}
                    maxLength={60}
                    placeholder="例如：招商银行经典白金卡"
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-3 text-[15px] text-ink placeholder:text-faint transition-all duration-200 sm:h-10 sm:text-sm dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">银行（必填）</span>
                  <input
                    value={newCard.bank}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, bank: event.target.value }))}
                    maxLength={60}
                    placeholder="例如：招商银行"
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-3 text-[15px] text-ink placeholder:text-faint transition-all duration-200 sm:h-10 sm:text-sm dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">地区</span>
                  <select
                    value={newCard.region}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, region: event.target.value }))}
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-2.5 text-[13px] font-semibold text-ink transition-all duration-200 sm:h-10 dark:bg-[#1c222d] ${FOCUS_RING}`}
                  >
                    {Object.keys(REGION_CURRENCY).map((label) => (
                      <option key={label} value={label}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">类型</span>
                  <select
                    value={newCard.type}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, type: event.target.value }))}
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-2.5 text-[13px] font-semibold text-ink transition-all duration-200 sm:h-10 dark:bg-[#1c222d] ${FOCUS_RING}`}
                  >
                    {CARD_TYPE_OPTIONS.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">卡组织</span>
                  <input
                    value={newCard.brand}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, brand: event.target.value }))}
                    maxLength={24}
                    placeholder="银联 / Visa / Mastercard"
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-3 text-[15px] text-ink placeholder:text-faint transition-all duration-200 sm:h-10 sm:text-sm dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">等级</span>
                  <input
                    value={newCard.level}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, level: event.target.value }))}
                    maxLength={24}
                    placeholder="普卡 / 金卡 / 白金"
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-3 text-[15px] text-ink placeholder:text-faint transition-all duration-200 sm:h-10 sm:text-sm dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                </label>
                <label className="col-span-2 flex flex-col gap-1.5">
                  <span className="text-[11px] font-semibold text-muted">币种范围</span>
                  <select
                    value={newCard.currencyScope}
                    onChange={(event) => setNewCard((prev) => ({ ...prev, currencyScope: event.target.value as CurrencyScope }))}
                    className={`h-11 w-full rounded-xl border border-edge bg-white px-2.5 text-[13px] font-semibold text-ink transition-all duration-200 sm:h-10 dark:bg-[#1c222d] ${FOCUS_RING}`}
                  >
                    {CURRENCY_SCOPE_ORDER.map((scope) => (
                      <option key={scope} value={scope}>
                        {CURRENCY_SCOPE_LABEL[scope]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-[11px] text-faint">
                保存后会进「全部卡面」（不自动加入我的卡），同时登记到「素材库 → 卡片」；需要时在列表里点「＋ 加入」收进「我的卡」。
              </p>
            </div>

            <div className="border-t border-edge px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
              {/* 按钮按内容宽度居中，不再拉满整行 */}
              <div className="flex justify-center">
                <button
                  type="button"
                  disabled={newSaving || newUploading || !newImage || !newCard.name.trim() || !newCard.bank.trim()}
                  onClick={() => void submitNewCard()}
                  className="h-11 rounded-xl bg-[#111] px-7 text-xs font-semibold text-white transition-transform duration-200 active:scale-[.99] disabled:opacity-40 dark:bg-white dark:text-[#111]"
                >
                  {newSaving ? "保存中…" : "保存卡片"}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {active && typeof document !== "undefined" && createPortal(
        // 顶部留出页头高度（72px）：弹层整体落在页头下方，既不压页头、也不会被页头盖住
        <div className="fixed inset-0 z-[10002] flex items-end justify-center bg-black/60 px-0 pb-0 pt-[72px] sm:items-center sm:px-4 sm:pb-4 sm:pt-[88px]" onClick={() => setActive(null)}>
          <div
            className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-edge bg-white shadow-2xl supports-[height:100dvh]:max-h-[86dvh] sm:rounded-card dark:border-white/10 dark:bg-[#16181d]"
            onClick={(event) => event.stopPropagation()}
          >
            {/* 手机：底部抽屉的抓手 */}
            <span className="mx-auto mt-2.5 block h-1 w-10 flex-none rounded-full bg-edge-strong sm:hidden" />
            <div className="flex items-start justify-between gap-3 border-b border-edge px-4 py-3.5 sm:px-5 sm:py-4">
              <div className="min-w-0">
                <h3 translate="no" className="notranslate truncate text-base font-bold text-ink">{cardTitle(active.card.name, script)}</h3>
                <p translate="no" className="notranslate mt-0.5 truncate text-xs text-muted">
                  {regionTitle(active.region, script)} · {bankTitle(active.bank, script)}
                  {script !== "english" && active.bank.englishName && active.bank.englishName !== active.bank.name
                    ? `（${active.bank.englishName}）`
                    : ""}
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
              <button type="button" onClick={() => setActive(null)} aria-label="关闭" className="grid h-10 w-10 flex-none place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2 sm:h-8 sm:w-8">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto overscroll-contain bg-bg-gray px-4 py-4 sm:px-5 sm:py-5 dark:bg-black/20">
              <div className="group/card relative mx-auto w-full max-w-[560px]">
                {/* 鼠标划过和卡面库里的卡片一样：轻微放大 + 底部渐变浮出来 */}
                {activeFaces.length > 1 ? (
                  /* 一张卡有多版卡面（新 / 旧）：点卡片翻面，和卡包的卡背切换同一套手感 */
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setFaceIndex((index) => (index + 1) % activeFaces.length)}
                      aria-label="翻看另一版卡面"
                      title="点一下翻看另一版卡面"
                      className="relative block w-full [perspective:1400px]"
                    >
                      <span
                        className="relative block w-full transition-transform duration-[620ms] ease-[cubic-bezier(.22,.61,.36,1)] [transform-style:preserve-3d]"
                        style={{ transform: `rotateY(${faceIndex * 180}deg)` }}
                      >
                        {/* 圆角 / 阴影 / 裁切放在每一面自己身上（外层 overflow 裁不住 3D 翻转的内容） */}
                        {activeFaces.map((item, index) => (
                          <span
                            key={item.file}
                            /* 固定成银行卡标准比例：和网格里的卡片一致 ——
                               恢复原图 / 换过自定义卡面时，图片比例不同也不会把详情页撑变形 */
                            className={`block aspect-[1.586] overflow-hidden rounded-xl bg-bg-gray shadow-pop [backface-visibility:hidden] dark:bg-white/5 ${
                              index === 0 ? "relative" : "absolute inset-0"
                            }`}
                            style={index === 0 ? undefined : { transform: `rotateY(${index * 180}deg)` }}
                          >
                            <img
                              src={cardCover(item.file)}
                              alt={index === 0 ? active.card.name : `${active.card.name} · ${item.label}`}
                              className="block h-full w-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-[1.02]"
                            />
                          </span>
                        ))}
                      </span>
                    </button>
                    <span className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-t from-black/35 via-black/0 to-black/0 opacity-0 transition-opacity duration-300 group-hover/card:opacity-100" />
                  </div>
                ) : (
                  /* 同上：保持银行卡标准比例，原图与自定义卡面在详情页里尺寸一致 */
                  <div className="relative aspect-[1.586] overflow-hidden rounded-xl bg-bg-gray shadow-pop dark:bg-white/5">
                    <img
                      src={cardCover(active.card.file)}
                      alt={active.card.name}
                      className="block h-full w-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-[1.04]"
                    />
                    <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-black/0 to-black/0 opacity-0 transition-opacity duration-300 group-hover/card:opacity-100" />
                  </div>
                )}
                {/* 多版卡面：和卡包一样的小圆点 + 当前是哪一版 */}
                {isFreshEntry(active.card, firstSeen, nowMs) && (
                  <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-full bg-black/35 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#fbbf24] ring-1 ring-inset ring-white/20 backdrop-blur-sm">
                    new
                  </span>
                )}
                {activeFaces.length > 1 && (
                  <div className="mt-3 flex items-center justify-center gap-2">
                    {activeFaces.map((item, index) => (
                      <button
                        key={item.file}
                        type="button"
                        onClick={() => setFaceIndex(index)}
                        aria-label={item.label}
                        className={`relative h-1.5 rounded-full transition-all duration-300 after:absolute after:-inset-3 after:content-[''] ${
                          index === faceIndex ? "w-4 bg-ink dark:bg-white" : "w-1.5 bg-faint/60 hover:bg-faint"
                        }`}
                      />
                    ))}
                    <span className="ml-1 text-[11px] font-semibold text-muted">{activeFace?.label}</span>
                    <span className="text-[11px] text-faint">· 点卡片翻面</span>
                  </div>
                )}
                {/* 卡片右上角：加入 / 移出我的卡、上传卡面（换过图的再给一颗恢复原图） */}
                {/* 默认藏起来，划过卡片（或键盘聚焦）才出现；触屏设备从 touch.css 里恢复常显 */}
                <div className="card-actions absolute right-2 top-2 flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/card:opacity-100 pointer-events-none focus-within:pointer-events-auto group-hover/card:pointer-events-auto">
                  <button
                    type="button"
                    onClick={() => void setHeld(active.card.file, !holdings[active.card.file])}
                    aria-label={holdings[active.card.file] ? "移出我的卡" : "加入我的卡"}
                    className="group/tip relative grid h-10 w-10 place-items-center rounded-full bg-black/45 sm:h-9 sm:w-9 text-white backdrop-blur transition-colors duration-200 hover:bg-black/60 active:scale-95"
                  >
                    {holdings[active.card.file] ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 text-[#f87171]">
                        <path d="M6 12h12" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4">
                        <path d="M12 6v12M6 12h12" />
                      </svg>
                    )}
                    {/* 自绘提示：原生 title 要等一两秒才出来 */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-0 top-[calc(100%+7px)] z-10 whitespace-nowrap rounded-lg bg-[#1c222d]/95 px-2 py-1 text-[11px] font-semibold text-white opacity-0 shadow-pop ring-1 ring-white/10 transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100"
                    >
                      {holdings[active.card.file] ? "移出我的卡" : "加入我的卡"}
                    </span>
                  </button>
                  <label
                    className={`group/tip relative grid h-10 w-10 cursor-pointer place-items-center rounded-full bg-black/45 sm:h-9 sm:w-9 text-white backdrop-blur transition-colors duration-200 hover:bg-black/60 active:scale-95 ${
                      coverSaving ? "pointer-events-none opacity-60" : ""
                    }`}
                  >
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
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M12 15V4M8 7.5 12 3.5l4 4M5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V15" />
                    </svg>
                    <span
                      aria-hidden
                      className="pointer-events-none absolute right-0 top-[calc(100%+7px)] z-10 whitespace-nowrap rounded-lg bg-[#1c222d]/95 px-2 py-1 text-[11px] font-semibold text-white opacity-0 shadow-pop ring-1 ring-white/10 transition-opacity duration-100 group-hover/tip:opacity-100"
                    >
                      {coverSaving ? "上传中…" : "上传卡面"}
                    </span>
                  </label>
                  {hasCustomCover(active.card.file) && (
                    <button
                      type="button"
                      disabled={coverSaving}
                      onClick={() => void resetCover(active)}
                      aria-label={active.card.file.startsWith("/") ? "恢复最初上传的卡面" : "恢复清单原图"}
                      className="group/tip relative grid h-10 w-10 place-items-center rounded-full bg-black/45 sm:h-9 sm:w-9 text-white backdrop-blur transition-colors duration-200 hover:bg-black/60 active:scale-95 disabled:opacity-50"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                        <path d="M4 12a8 8 0 1 0 2.6-5.9" />
                        <path d="M4 4v4.5h4.5" />
                      </svg>
                      <span
                        aria-hidden
                        className="pointer-events-none absolute right-0 top-[calc(100%+7px)] z-10 whitespace-nowrap rounded-lg bg-[#1c222d]/95 px-2 py-1 text-[11px] font-semibold text-white opacity-0 shadow-pop ring-1 ring-white/10 transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100"
                      >
                        {active.card.file.startsWith("/") ? "恢复最初上传的卡面" : "恢复清单原图"}
                      </span>
                    </button>
                  )}
                </div>
              </div>
              <div className="mx-auto mt-4 grid max-w-[560px] grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">类型<b className="ml-1 text-ink">{(active.card.type && typeTitle(active.card.type, script)) || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">卡组织<b className="ml-1 text-ink">{active.card.brand || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">等级<b className="ml-1 text-ink">{active.card.level || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">卡号前几位<b className="ml-1 text-ink">{active.card.bins?.length ? active.card.bins.join(" / ") : "—"}</b></span>
              </div>
              {/* 币种范围：规则推断 + 手动覆盖（存 card_details.currency_scope） */}
              {activeScope && (
                <div className="mx-auto mt-2 max-w-[560px] rounded-xl bg-white px-3 py-2.5 dark:bg-[#1c222d]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[11px] font-semibold text-muted">币种范围</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${SCOPE_CHIP_CLASS[activeScope.scope]}`}>
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
                      className={`h-8 rounded-full border px-3.5 text-[11px] font-semibold transition-colors duration-200 disabled:opacity-50 max-sm:h-10 ${
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
                        className={`h-8 rounded-full border px-3.5 text-[11px] font-semibold transition-colors duration-200 disabled:opacity-50 max-sm:h-10 ${
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
              {/* 自建卡才有删除入口：卡片和它在素材库里登记的卡面一起删 */}
              {active.card.custom && (
                <div className="mx-auto mt-4 max-w-[560px] text-center">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void removeCustomCard(active)}
                    className="text-[11px] font-semibold text-[#e5484d] transition-opacity duration-200 hover:opacity-80 disabled:opacity-40"
                  >
                    删除这张自定义卡片（会同时移除素材库里的卡面）
                  </button>
                </div>
              )}
            </div>
            <div className="border-t border-edge px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3.5 sm:px-5 sm:py-4">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-muted">币种</span>
                  {activeCurrencyOptions.length > 1 ? (
                    <select
                      value={draft.currency}
                      onChange={(event) => setDraft((prev) => ({ ...prev, currency: event.target.value }))}
                      title="只列出这张卡能记的币种"
                      className={`h-11 rounded-xl border border-edge bg-white px-2 text-xs font-semibold text-ink transition-all duration-200 sm:h-9 dark:bg-[#1c222d] ${FOCUS_RING}`}
                    >
                      {activeCurrencyOptions.map((code) => (
                        <option key={code} value={code}>
                          {code} · {currencyName(code)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    // 单币卡：币种是固定的，不再给一个只有一个选项的下拉
                    <span
                      title="单币卡：这张卡只有这一个币种（在下面的「币种范围」里可以改成双币 / 多币种）"
                      className="flex h-11 items-center rounded-xl border border-edge bg-bg-gray px-3 text-xs font-semibold text-ink-2 sm:h-9 dark:border-white/10 dark:bg-white/5 dark:text-white/80"
                    >
                      {activeCurrencyOptions[0] ?? "—"} · {currencyName(activeCurrencyOptions[0] ?? "")}
                    </span>
                  )}
                </label>
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
                {/* 自定义标签：点末尾的「+」原地变输入框，回车 / 失焦保存，Esc 取消 */}
                {tagInputOpen ? (
                  <input
                    autoFocus
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addTag(tagDraft);
                        setTagInputOpen(false);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setTagDraft("");
                        setTagInputOpen(false);
                      }
                    }}
                    onBlur={() => {
                      addTag(tagDraft);
                      setTagDraft("");
                      setTagInputOpen(false);
                    }}
                    maxLength={12}
                    placeholder="标签名"
                    className={`h-9 w-[112px] rounded-full border border-edge bg-white px-2.5 text-[12px] text-ink placeholder:text-faint transition-all duration-200 sm:h-7 sm:w-[100px] sm:text-[11px] dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setTagInputOpen(true)}
                    disabled={activeUserTags.length >= 10}
                    aria-label="添加自定义标签"
                    title={activeUserTags.length >= 10 ? "最多 10 个标签" : "添加自定义标签"}
                    className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-edge-strong text-muted transition-colors hover:bg-brand-hover hover:text-ink disabled:opacity-40 sm:h-7 sm:w-7"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-3.5 w-3.5">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 手机：滑到列表深处时右下角浮出「回到顶部」 */}
      {showTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="回到顶部"
          title="回到顶部"
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 grid h-11 w-11 place-items-center rounded-full border border-edge bg-white/95 text-muted shadow-pop backdrop-blur transition-colors duration-200 hover:text-ink sm:hidden dark:border-white/10 dark:bg-[#1c222d]/95 dark:text-white/70"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M12 19V5M6 11l6-6 6 6" />
          </svg>
        </button>
      )}

      {/* 卡包也 portal：否则整屏视图的顶部同样会被吸顶页头盖住 */}
      {walletOpen && typeof document !== "undefined" && createPortal(
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
          onCoverChanged={(cardKey, url) => setCovers((prev) => ({ ...prev, [cardKey]: url }))}
        />,
        document.body
      )}
    </div>
  );
}
