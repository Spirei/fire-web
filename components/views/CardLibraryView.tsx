"use client";

import { useEffect, useMemo, useState } from "react";

interface CardItem {
  name: string;
  type: string;
  file: string;
  sourceType?: string;
  brand?: string;
  level?: string;
  bins?: number[];
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

interface CardUrl {
  card: CardItem;
  bank: BankEntry;
  region: string;
}

const ALL = "全部";

function Pill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-200 ${
        active ? "seg-active" : "text-muted hover:bg-brand-hover hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export default function CardLibraryView() {
  const [regions, setRegions] = useState<RegionEntry[]>([]);
  const [typeOrder, setTypeOrder] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<CardUrl | null>(null);

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
    const list: CardUrl[] = [];
    regions.forEach((entry) => {
      entry.banks.forEach((bank) => {
        bank.cards.forEach((card) => list.push({ card, bank, region: entry.label }));
      });
    });
    return list;
  }, [regions]);

  /** 类型顺序：清单给的顺序优先，其余按出现次数补在后面 */
  const typeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    flat.forEach(({ card }) => counts.set(card.type || "其他", (counts.get(card.type || "其他") ?? 0) + 1));
    const ordered = [...typeOrder.filter((item) => counts.has(item)), ...[...counts.keys()].filter((item) => !typeOrder.includes(item))];
    return [{ key: ALL, label: ALL, count: flat.length }, ...ordered.map((item) => ({ key: item, label: item, count: counts.get(item) ?? 0 }))];
  }, [flat, typeOrder]);

  const regionOptions = useMemo(
    () => [{ key: ALL, label: ALL, count: flat.length }, ...regions.map((entry) => ({ key: entry.label, label: entry.label, count: entry.banks.reduce((sum, bank) => sum + bank.cards.length, 0) }))],
    [regions, flat.length]
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return flat.filter(({ card, bank, region: regionLabel }) => {
      if (region !== ALL && regionLabel !== region) return false;
      if (type !== ALL && (card.type || "其他") !== type) return false;
      if (!keyword) return true;
      return (
        card.name.toLowerCase().includes(keyword) ||
        bank.name.toLowerCase().includes(keyword) ||
        (bank.englishName || "").toLowerCase().includes(keyword) ||
        (card.brand || "").toLowerCase().includes(keyword)
      );
    });
  }, [flat, region, type, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold">卡面库</h2>
          <p className="mt-1 text-xs text-muted">
            {flat.length > 0 ? `共 ${flat.length} 张卡面 · ${regions.length} 个地区` : "还没有卡面素材"}
            {updatedAt ? ` · 更新于 ${new Date(updatedAt).toLocaleDateString("zh-CN")}` : ""}
          </p>
        </div>
        <label className="relative block">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted">
            <circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="卡名 / 银行 / 卡组织"
            className="h-9 w-[220px] rounded-full border border-edge-strong bg-white pl-8 pr-3 text-xs text-ink placeholder:text-faint dark:bg-[#1c222d]"
          />
        </label>
      </div>

      <div className="card p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[11px] font-semibold text-faint">地区</span>
          <div className="flex min-w-0 max-w-full flex-wrap gap-0.5 rounded-xl border border-edge-strong bg-bg-gray/60 p-0.5 text-[11px] font-semibold">
            {regionOptions.map((option) => (
              <Pill key={option.key} active={region === option.key} onClick={() => setRegion(option.key)}>
                {option.label}
                <span className="ml-1 text-faint">{option.count}</span>
              </Pill>
            ))}
          </div>
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-[11px] font-semibold text-faint">类型</span>
          <div className="flex min-w-0 max-w-full flex-wrap gap-0.5 rounded-xl border border-edge-strong bg-bg-gray/60 p-0.5 text-[11px] font-semibold">
            {typeOptions.map((option) => (
              <Pill key={option.key} active={type === option.key} onClick={() => setType(option.key)}>
                {option.label}
                <span className="ml-1 text-faint">{option.count}</span>
              </Pill>
            ))}
          </div>
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
      ) : filtered.length === 0 ? (
        <div className="card py-16 text-center text-sm text-muted">没有符合条件的卡面</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map(({ card, bank, region: regionLabel }) => (
            <button
              key={`${bank.folder}-${card.file}`}
              type="button"
              onClick={() => setActive({ card, bank, region: regionLabel })}
              className="group flex flex-col overflow-hidden rounded-2xl border border-edge bg-white text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-pop dark:bg-[#16181d]"
            >
              <span className="block w-full overflow-hidden bg-bg-gray">
                <img
                  src={`/uploads/cards/${card.file}`}
                  alt={card.name}
                  loading="lazy"
                  className="aspect-[1.586] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
                <b className="truncate text-[13px] font-semibold text-ink">{card.name}</b>
                <small className="truncate text-[11px] text-muted">
                  {bank.name}
                  {card.brand ? ` · ${card.brand}` : ""}
                </small>
              </span>
            </button>
          ))}
        </div>
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
            </div>
            {/* 录入金额：本版只放界面占位，功能下一版接入 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-edge px-5 py-4">
              <span className="text-xs font-semibold text-muted">录入金额</span>
              <input
                disabled
                placeholder="下一版接入"
                className="h-9 w-[180px] rounded-xl border border-edge bg-bg-gray px-3 text-xs text-ink placeholder:text-faint disabled:opacity-60 dark:bg-[#1c222d]"
              />
              <button type="button" disabled className="h-9 rounded-xl border border-edge-strong bg-white px-4 text-xs font-semibold text-ink-2 transition-colors duration-200 hover:bg-brand-hover disabled:opacity-50 dark:bg-[#1c1c1e] dark:text-white">
                保存
              </button>
              <span className="text-[11px] text-faint">（金额录入功能下一版接入）</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
