"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { showToast } from "@/lib/toast";
import { cardTagsOf } from "@/lib/cardTags";
import { FALLBACK_RATES } from "@/lib/types";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { readCachedRates, writeCachedRates } from "@/lib/ratesCache";

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

/** 卡面库自己的币种表（覆盖素材里出现的国家地区，不走持仓的币种偏好） */
const CARD_CURRENCIES: { code: string; symbol: string; label: string }[] = [
  { code: "CNY", symbol: "¥", label: "人民币" },
  { code: "USD", symbol: "$", label: "美元" },
  { code: "HKD", symbol: "HK$", label: "港元" },
  { code: "TWD", symbol: "NT$", label: "新台币" },
  { code: "MOP", symbol: "MOP$", label: "澳门元" },
  { code: "JPY", symbol: "¥", label: "日元" },
  { code: "KRW", symbol: "₩", label: "韩元" },
  { code: "SGD", symbol: "S$", label: "新加坡元" },
  { code: "GBP", symbol: "£", label: "英镑" },
  { code: "EUR", symbol: "€", label: "欧元" },
  { code: "AUD", symbol: "A$", label: "澳元" },
  { code: "CAD", symbol: "C$", label: "加元" },
  { code: "RUB", symbol: "₽", label: "卢布" },
  { code: "KZT", symbol: "₸", label: "坚戈" }
];

const REGION_CURRENCY: Record<string, string> = {
  中国内地: "CNY",
  中国香港: "HKD",
  中国台湾: "TWD",
  中国澳门: "MOP",
  美国: "USD",
  日本: "JPY",
  韩国: "KRW",
  新加坡: "SGD",
  英国: "GBP",
  德国: "EUR",
  爱尔兰: "EUR",
  澳大利亚: "AUD",
  加拿大: "CAD",
  俄罗斯: "RUB",
  哈萨克斯坦: "KZT"
};

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

function currencySymbol(code: string): string {
  return CARD_CURRENCIES.find((item) => item.code === code)?.symbol ?? (code ? `${code} ` : "");
}

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

function FilterGroup({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: { key: string; count?: number }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="mr-0.5 text-[11px] font-semibold text-faint">{label}</span>
      {options.map((option) => (
        <Pill key={option.key} active={value === option.key} onClick={() => onChange(option.key)}>
          {option.key}
          {option.count !== undefined && (
            <span className={`ml-1.5 ${value === option.key ? "text-white/60 dark:text-[#111]/50" : "text-faint"}`}>{option.count}</span>
          )}
        </Pill>
      ))}
    </div>
  );
}

/** 下拉筛选（参考卡的筛选条：浅色圆角 + 右侧箭头），支持 optgroup 分组 */
function FilterSelect({
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  label: string;
  value: string;
  options: { value: string; label: string; group?: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const groups = new Map<string, { value: string; label: string }[]>();
  options.forEach((option) => {
    const key = option.group || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ value: option.value, label: option.label });
  });
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-muted">{label}</span>
      <span className="relative block">
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={`h-10 w-full appearance-none rounded-xl border border-edge bg-white px-3 pr-8 text-sm font-semibold text-ink transition-all duration-200 hover:border-edge-strong disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#1c222d] dark:text-white ${FOCUS_RING}`}
        >
          {[...groups.entries()].map(([group, items]) =>
            group ? (
              <optgroup key={group} label={group}>
                {items.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              items.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))
            )
          )}
        </select>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted">
          <path d="m5 7 5 5 5-5" />
        </svg>
      </span>
    </label>
  );
}

export default function CardLibraryView() {
  const [regions, setRegions] = useState<RegionEntry[]>([]);
  const [typeOrder, setTypeOrder] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, CardAmount>>({});
  const [holdings, setHoldings] = useState<Record<string, boolean>>({});
  /** mine = 我的卡（默认）；all = 全量卡面库，用来挑卡加入 */
  const [mode, setMode] = useState<"mine" | "all">("mine");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(true);

  const [region, setRegion] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [bankFolder, setBankFolder] = useState(ALL);
  const [brand, setBrand] = useState(ALL);
  const [level, setLevel] = useState(ALL);
  const [tag, setTag] = useState(ALL);
  const [myTag, setMyTag] = useState(ALL);
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [active, setActive] = useState<CardEntry | null>(null);
  const [draft, setDraft] = useState({ amount: "", currency: "CNY", note: "" });
  const [saving, setSaving] = useState(false);
  const [userTags, setUserTags] = useState<Record<string, string[]>>({});
  const [tagDraft, setTagDraft] = useState("");

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cards")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setRegions(Array.isArray(data.regions) ? data.regions : []);
        setTypeOrder(Array.isArray(data.typeOrder) ? data.typeOrder : []);
        setUpdatedAt(typeof data.updatedAt === "string" ? data.updatedAt : null);
        setHint(typeof data.error === "string" ? data.error : "");
        const map: Record<string, CardAmount> = {};
        (Array.isArray(data.amounts) ? data.amounts : []).forEach((item: CardAmount) => {
          if (item?.cardKey) map[item.cardKey] = item;
        });
        setAmounts(map);
        setUserTags(data.tags && typeof data.tags === "object" ? (data.tags as Record<string, string[]>) : {});
        const held: Record<string, boolean> = {};
        (Array.isArray(data.holdings) ? data.holdings : []).forEach((key: string) => {
          if (key) held[key] = true;
        });
        setHoldings(held);
      })
      .catch(() => {
        if (!cancelled) setHint("卡面库加载失败，稍后重试");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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

  type Facet = "region" | "bank" | "type" | "brand" | "level" | "tag" | "myTag" | null;
  const keyword = query.trim().toLowerCase();

  /** 分面匹配：skip 传入当前正在统计的维度时，该维度本身不参与过滤（标准 facet 行为） */
  const matchesExcept = (entry: CardEntry, skip: Facet) => {
    const { card, bank, region: regionLabel, tags } = entry;
    if (mode === "mine" && !holdings[card.file]) return false;
    if (skip !== "region" && region !== ALL && regionLabel !== region) return false;
    if (skip !== "bank" && bankFolder !== ALL && bank.folder !== bankFolder) return false;
    if (skip !== "type" && type !== ALL && (card.type || "其他") !== type) return false;
    if (skip !== "brand" && brand !== ALL && (card.brand || "").trim() !== brand) return false;
    if (skip !== "level" && level !== ALL && (card.level || "").trim() !== level) return false;
    if (skip !== "tag" && tag !== ALL && !tags.includes(tag)) return false;
    if (skip !== "myTag" && myTag !== ALL && !(userTags[card.file] ?? []).includes(myTag)) return false;
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

  // 每个维度统计时把「自己」排除在外，这样各筛选器的数字会随其他条件联动（搜「招商」→ 类型数字变成招商的分布）
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
      { value: ALL, label: region === ALL ? "全部银行" : `全部银行（${region}）` }
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
          group: region === ALL ? `${REGION_CONTINENT[regionLabel] ?? "其他"} · ${regionLabel}` : undefined
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

  /** 筛选条件变化时回到第一屏 */
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [region, bankFolder, type, brand, level, tag, myTag, onlyFilled, query]);

  const pageItems = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const activeUserTags = active ? userTags[active.card.file] ?? [] : [];

  /** 我的卡总览：持有张数 + 各类型张数 + 额度合计（只统计持有的卡；按币种分组折算成显示货币） */
  const wallet = useMemo(() => {
    const heldEntries = flat.filter(({ card }) => holdings[card.file]);
    const byType = new Map<string, number>();
    heldEntries.forEach(({ card }) => {
      const key = card.type || "其他";
      byType.set(key, (byType.get(key) ?? 0) + 1);
    });
    const byCurrency = new Map<string, { total: number; count: number }>();
    const missing: string[] = [];
    let converted = 0;
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
      const usdRate = rates[code];
      if (usdRate && usdRate > 0) converted += (item.amount / usdRate) * displayRate;
      else if (!missing.includes(code)) missing.push(code);
    });
    return {
      count: heldEntries.length,
      filled,
      byType: [...byType.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN")),
      byCurrency: [...byCurrency.entries()].sort((a, b) => b[1].total - a[1].total),
      converted,
      missing
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
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
        <div className="flex items-center gap-2">
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setMode("mine")}
              className={`rounded-full border px-4 py-2 font-semibold transition-all duration-200 ${
                mode === "mine"
                  ? "border-[#111] bg-[#111] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#111]"
                  : "border-edge bg-white text-ink-2 hover:border-edge-strong hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
              }`}
            >
              我的卡 {heldCount}
            </button>
            <button
              type="button"
              onClick={() => setMode("all")}
              className={`rounded-full border px-4 py-2 font-semibold transition-all duration-200 ${
                mode === "all"
                  ? "border-[#111] bg-[#111] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#111]"
                  : "border-edge bg-white text-ink-2 hover:border-edge-strong hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
              }`}
            >
              全部卡面 {flat.length}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setOnlyFilled((value) => !value)}
            title="只看已录入金额的卡"
            className={`h-9 rounded-full border px-3.5 text-xs font-semibold transition-all duration-200 ${
              onlyFilled
                ? "border-[#111] bg-[#111] text-white shadow-sm dark:border-white dark:bg-white dark:text-[#111]"
                : "border-edge bg-white text-ink-2 hover:border-edge-strong hover:bg-brand-hover dark:border-white/10 dark:bg-[#1c222d] dark:text-white/80 dark:hover:bg-white/10"
            }`}
          >
            已录入 {filledCount}
          </button>
        </div>
      </div>

      {/* 搜索：参考卡的筛选条，搜索框独立一行 */}
      <label className="relative block w-full max-w-[520px]">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted">
          <circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />
        </svg>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索银行、卡片名称或关键词"
          className={`h-10 w-full rounded-xl border border-edge bg-white pl-10 pr-3 text-sm text-ink placeholder:text-faint transition-all duration-200 hover:border-edge-strong dark:bg-[#1c222d] ${FOCUS_RING}`}
        />
      </label>

      {wallet.count > 0 && (
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
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted">额度合计</span>
              {wallet.filled > 0 ? (
                <span className="text-sm font-bold tabular-nums text-ink">
                  ≈ {currencySymbol(displayCurrency)}
                  {wallet.converted.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              ) : (
                <span className="text-xs text-faint">未录入（打开卡片可录入金额）</span>
              )}
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

      <div className="card p-3">
        <FilterGroup label="类型" options={typeOptions} value={type} onChange={setType} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <FilterSelect
            label="地区"
            value={region}
            options={[
              { value: ALL, label: "全部地区" },
              ...regionOptions
                .slice(1)
                .map((option) => ({
                  value: option.key,
                  label: `${option.key}（${option.count}）`,
                  group: REGION_CONTINENT[option.key] ?? "其他"
                }))
            ]}
            onChange={(next) => {
              setRegion(next);
              setBankFolder(ALL);
            }}
          />
          <FilterSelect label="银行" value={bankFolder} options={bankSelectOptions} onChange={setBankFolder} />
          <FilterSelect
            label="卡组织"
            value={brand}
            options={[
              { value: ALL, label: "全部卡组织" },
              ...brandOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))
            ]}
            onChange={setBrand}
          />
          <FilterSelect
            label="等级"
            value={level}
            options={[
              { value: ALL, label: "全部等级" },
              ...levelOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))
            ]}
            onChange={setLevel}
          />
          <FilterSelect
            label="主题"
            value={tag}
            options={[
              { value: ALL, label: "全部主题" },
              ...tagOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))
            ]}
            onChange={setTag}
          />
          {myTagOptions.length > 0 && (
            <FilterSelect
              label="我的标签"
              value={myTag}
              options={[
                { value: ALL, label: "全部我的标签" },
                ...myTagOptions.slice(1).map((option) => ({ value: option.key, label: `${option.key}（${option.count}）` }))
              ]}
              onChange={setMyTag}
            />
          )}
        </div>
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
            className="rounded-full border border-edge-strong bg-white px-4 py-2 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover dark:bg-[#1c1c1e] dark:text-white"
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
            return (
              <button
                key={`${bank.folder}-${card.file}`}
                type="button"
                onClick={() => openCard({ card, bank, region: regionLabel, tags })}
                className="group flex flex-col overflow-hidden rounded-2xl border border-edge bg-white text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-pop dark:bg-[#16181d]"
              >
                <span className="relative block w-full overflow-hidden bg-bg-gray">
                  <img
                    src={`/uploads/cards/${card.file}`}
                    alt={card.name}
                    loading="lazy"
                    className="aspect-[1.586] w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                  />
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                  {saved && (
                    <span className="absolute bottom-2 left-2 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                      {fmtAmount(saved.amount, saved.currency)}
                    </span>
                  )}
                  <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
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
                      className={`absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold shadow-sm transition-colors duration-200 ${
                        isHeld ? "bg-white/90 text-[#2f6fed]" : "bg-white/90 text-ink-2 hover:bg-white"
                      }`}
                    >
                      {isHeld ? "移出" : "+ 加入"}
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                  <b className="truncate text-[13px] font-semibold text-ink">{card.name}</b>
                  <small className="truncate text-[11px] text-muted">
                    {bank.name}
                    {card.brand ? ` · ${card.brand}` : ""}
                    {card.level ? ` · ${card.level}` : ""}
                  </small>
                  {shownTags.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {shownTags.slice(0, 3).map((item) => (
                        <i
                          key={item}
                          className={`rounded-full px-1.5 py-[1px] text-[9px] font-semibold not-italic ${
                            mine.includes(item)
                              ? "bg-[#3297f6]/12 text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]"
                              : "bg-brand-light text-brand-deep dark:bg-white/10 dark:text-white/70"
                          }`}
                        >
                          {item}
                        </i>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {filtered.length > pageItems.length && (
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            className="card mx-auto flex w-full items-center justify-center gap-1.5 py-3 text-xs font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink"
          >
            加载更多（剩余 {filtered.length - pageItems.length} 张）
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><path d="m5 7 5 5 5-5" /></svg>
          </button>
        )}
        </>
      )}

      {active && (
        <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 p-4" onClick={() => setActive(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-edge bg-white shadow-2xl dark:border-white/10 dark:bg-[#16181d]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-edge px-5 py-4">
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
              <button type="button" onClick={() => setActive(null)} aria-label="关闭" className="grid h-8 w-8 flex-none place-items-center rounded-full text-muted transition hover:bg-bg-gray hover:text-ink-2">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto bg-bg-gray px-5 py-5 dark:bg-black/20">
              <img src={`/uploads/cards/${active.card.file}`} alt={active.card.name} className="mx-auto w-full max-w-[560px] rounded-xl shadow-pop" />
              <div className="mx-auto mt-4 grid max-w-[560px] grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">类型<b className="ml-1 text-ink">{active.card.type || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">卡组织<b className="ml-1 text-ink">{active.card.brand || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">等级<b className="ml-1 text-ink">{active.card.level || "—"}</b></span>
                <span className="rounded-lg bg-white px-3 py-2 text-muted dark:bg-[#1c222d]">卡号前几位<b className="ml-1 text-ink">{active.card.bins?.length ? active.card.bins.join(" / ") : "—"}</b></span>
              </div>
              <p className="mx-auto mt-2 max-w-[560px] text-center text-[11px] text-faint">
                原图 {fileExt(active.card.file)}
                {active.card.bytes ? ` · ${fmtBytes(active.card.bytes)}` : ""}
                {` · ${active.card.file.split("/").slice(0, 2).join(" / ").split("/").map((segment) => decodeURIComponent(segment)).join(" / ")}`}
              </p>
            </div>
            <div className="border-t border-edge px-5 py-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-muted">
                  {holdings[active.card.file] ? "这张卡已在「我的卡」里，回卡面库默认就能看到" : "加入「我的卡」后，卡面库默认列表里就会出现它"}
                </span>
                <button
                  type="button"
                  onClick={() => void setHeld(active.card.file, !holdings[active.card.file])}
                  className={`h-8 rounded-full border px-3.5 text-xs font-semibold transition-all duration-200 hover:-translate-y-px active:scale-[.97] ${
                    holdings[active.card.file]
                      ? "border-edge-strong bg-white text-muted hover:bg-brand-hover hover:text-ink dark:bg-[#1c1c1e] dark:text-white/80"
                      : "border-[#3297f6] bg-[#3297f6] text-white hover:brightness-105"
                  }`}
                >
                  {holdings[active.card.file] ? "移出我的卡" : "加入我的卡"}
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-muted">金额</span>
                  <span className="flex items-center gap-1 rounded-xl border border-edge bg-white px-2 transition-all duration-200 focus-within:border-edge-strong focus-within:shadow-[0_0_0_3px_rgba(107,114,128,.15)] dark:bg-[#1c222d] dark:focus-within:border-white/20 dark:focus-within:shadow-[0_0_0_3px_rgba(255,255,255,.10)]">
                    <span className="text-xs font-semibold text-muted">{currencySymbol(draft.currency)}</span>
                    <input
                      value={draft.amount}
                      onChange={(event) => setDraft((prev) => ({ ...prev, amount: event.target.value.replace(/[^\d.]/g, "") }))}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-9 w-[130px] bg-transparent text-sm tabular-nums text-ink outline-none placeholder:text-faint"
                    />
                  </span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold text-muted">币种</span>
                  <select
                    value={draft.currency}
                    onChange={(event) => setDraft((prev) => ({ ...prev, currency: event.target.value }))}
                    className={`h-9 rounded-xl border border-edge bg-white px-2 text-xs font-semibold text-ink transition-all duration-200 dark:bg-[#1c222d] ${FOCUS_RING}`}
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
                    className={`h-9 rounded-xl border border-edge bg-white px-3 text-xs text-ink placeholder:text-faint transition-all duration-200 dark:bg-[#1c222d] ${FOCUS_RING}`}
                  />
                </label>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveAmount()}
                  className="h-9 rounded-xl border border-edge-strong bg-white px-4 text-xs font-semibold text-ink-2 transition-all duration-200 hover:-translate-y-px hover:bg-brand-hover active:scale-[.97] disabled:opacity-50 dark:bg-[#1c1c1e] dark:text-white"
                >
                  保存
                </button>
                {amounts[active.card.file] && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void clearAmount()}
                    className="h-9 rounded-xl px-3 text-xs font-semibold text-muted transition-colors duration-200 hover:bg-brand-hover hover:text-ink disabled:opacity-50"
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
                  <span key={item} className="inline-flex items-center gap-1 rounded-full bg-[#3297f6]/12 px-2 py-0.5 text-[11px] font-semibold text-[#2f6fed] dark:bg-[#3297f6]/20 dark:text-[#8fc0ff]">
                    {item}
                    <button
                      type="button"
                      onClick={() => removeTag(item)}
                      aria-label={`移除标签 ${item}`}
                      className="grid h-3.5 w-3.5 place-items-center rounded-full transition-colors hover:bg-black/10 dark:hover:bg-white/10"
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
                  className={`h-7 w-[130px] rounded-full border border-edge bg-white px-2.5 text-[11px] text-ink placeholder:text-faint transition-all duration-200 dark:bg-[#1c222d] ${FOCUS_RING}`}
                />
                {TAG_SUGGESTIONS.filter((item) => !activeUserTags.includes(item)).slice(0, 5).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => addTag(item)}
                    className="rounded-full border border-dashed border-edge-strong px-2 py-0.5 text-[11px] font-semibold text-muted transition-colors hover:bg-brand-hover hover:text-ink"
                  >
                    + {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
