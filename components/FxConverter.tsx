"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconPencil, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import CurrencyFlag from "@/components/CurrencyFlag";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { usePersistedState } from "@/lib/usePersistedState";
import { showToast } from "@/lib/toast";
import {
  FX_CURRENCIES,
  FX_EXTRA_CURRENCIES,
  FX_CONTINENTS,
  fxCurrencyMeta,
  fxContinent,
  type FxCurrency,
  amountToDraft,
  convertAmount,
  formatFxAmount,
  formatPairRate,
  formatRatesDate,
  isFxCurrency,
  mergeVisibleFxOrder,
  moveFxOrder,
  normalizeFxOrder,
  pairRate,
  parseFxAmount,
  sanitizeFxInput,
  visibleFxOrder
} from "@/lib/fxConvert";

const FX_ORDER_KEY = "fire:fx-order";
const FX_HIDDEN_KEY = "fire:fx-hidden";

function readUrlState(fallback: FxCurrency): { from: FxCurrency; amount: string } {
  if (typeof window === "undefined") return { from: fallback, amount: "100" };
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  const amount = params.get("amount");
  const parsed = amount != null ? parseFxAmount(amount) : 100;
  return {
    from: isFxCurrency(from) ? from : fallback,
    amount: parsed == null ? "100" : sanitizeFxInput(amount ?? "100")
  };
}

function DragHandle({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="drag-handle fx-converter-handle"
      aria-label={`拖动 ${label} 排序`}
      title="拖动排序"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
        <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
        <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
      </svg>
    </button>
  );
}

export default function FxConverter() {
  const { currency: displayCurrency } = useDisplayCurrency();
  const start = isFxCurrency(displayCurrency) ? displayCurrency : "USD";
  const [base, setBase] = useState<FxCurrency>(() => readUrlState(start).from);
  const [text, setText] = useState(() => readUrlState(start).amount);
  const [savedOrder, setSavedOrder] = usePersistedState<FxCurrency[]>(FX_ORDER_KEY, [...FX_CURRENCIES]);
  const [hidden, setHidden] = usePersistedState<FxCurrency[]>(FX_HIDDEN_KEY, []);
  const [rates, setRates] = useState<Record<string, number>>({ USD: 1 });
  const [quoted, setQuoted] = useState<Set<string>>(() => new Set(["USD"]));
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [estimatedMop, setEstimatedMop] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [rateError, setRateError] = useState("");
  const allCodes = normalizeFxOrder(savedOrder);
  const codes = visibleFxOrder(savedOrder, hidden);
  const visibleKey = codes.join("|");
  const addable = [...FX_CURRENCIES, ...FX_EXTRA_CURRENCIES].filter(code => !codes.includes(code) && (code === "MOP" || FX_CURRENCIES.includes(code as typeof FX_CURRENCIES[number]) || (quoted.has(code) && (rates[code] ?? 0) > 0))).sort((a, b) => a.localeCompare(b));
  const addableByContinent = FX_CONTINENTS.map(continent => ({ continent, items: addable.filter(code => fxContinent(code) === continent) })).filter(group => group.items.length > 0);
  const inputRefs = useRef<Partial<Record<FxCurrency, HTMLInputElement | null>>>({});
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("section", "convert");
    params.set("from", base);
    const parsed = parseFxAmount(text);
    if (parsed == null) params.delete("amount");
    else params.set("amount", sanitizeFxInput(text));
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [base, text]);

  useEffect(() => {
    if (codes.length && !codes.includes(base)) {
      setBase(codes[0]);
      setText("100");
    }
  }, [base, visibleKey]);

  const loadRates = useCallback(async (force = false) => {
      if (force) setRefreshing(true);
      setRateError("");
      try {
        const response = await fetch(force ? "/api/rates?refresh=1" : "/api/rates");
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.rates) throw new Error(data?.error || "获取汇率失败");
        const quotedList = Array.isArray(data.quoted)
          ? data.quoted.filter((code: unknown): code is string => typeof code === "string" && /^[A-Z]{3}$/.test(code))
          : [];
        const nextQuoted = new Set<string>(["USD", ...quotedList]);
        const nextRates: Record<string, number> = { USD: 1 };
        nextQuoted.forEach((code) => {
          const value = Number(data.rates[code]);
          if (value > 0) nextRates[code] = code === "USD" ? 1 : value;
        });
        const mopFromHkd = !nextRates.MOP && nextQuoted.has("HKD") && nextRates.HKD > 0;
        if (mopFromHkd) {
          nextRates.MOP = nextRates.HKD * 1.03;
          nextQuoted.add("MOP");
        }
        setEstimatedMop(Boolean(mopFromHkd));
        setQuoted(nextQuoted);
        setRates(nextRates);
        setUpdatedAt(typeof data.updatedAt === "number" && data.updatedAt > 0 ? data.updatedAt : null);
        if (force) showToast("汇率已刷新");
      } catch {
        if (force) {
          setRateError("刷新失败，请稍后重试");
          showToast("汇率刷新失败");
        }
      } finally {
        if (force) setRefreshing(false);
      }
  }, []);

  useEffect(() => {
    void loadRates();
    const onRates = () => { void loadRates(); };
    window.addEventListener("fire:rates-updated", onRates);
    return () => window.removeEventListener("fire:rates-updated", onRates);
  }, [loadRates]);

  useEffect(() => {
    if (!adding) return;
    const closeOutside = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAdding(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAdding(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [adding]);

  const amount = parseFxAmount(text);

  function hasQuote(code: string) {
    return quoted.has(code) && (code === "USD" || (rates[code] ?? 0) > 0);
  }

  function activate(next: FxCurrency) {
    if (next === base || !hasQuote(next)) return;
    if (amount != null) {
      const converted = convertAmount(amount, base, next, rates);
      setText(converted == null ? "" : amountToDraft(converted, next));
    }
    setBase(next);
  }

  function onDrop(to: number) {
    const from = dragFrom.current;
    dragFrom.current = null;
    setOver(null);
    setDragging(null);
    if (from == null || from === to) return;
    const next = moveFxOrder(codes, from, to);
    if (next === codes) return;
    setSavedOrder(mergeVisibleFxOrder(allCodes, next));
    showToast("顺序已保存");
  }

  function addCurrency(code: FxCurrency) {
    if (!allCodes.includes(code)) setSavedOrder([...allCodes, code]);
    setHidden(current => current.filter(item => item !== code));
    if (!codes.length) {
      setBase(code);
      setText("100");
    }
    setAdding(false);
  }

  function removeCurrency(code: FxCurrency) {
    if (code === base) {
      const next = codes.find(item => item !== code && hasQuote(item));
      if (next) activate(next);
      else {
        const fallback = codes.find(item => item !== code);
        if (fallback) {
          setBase(fallback);
          setText("100");
        }
      }
    }
    setHidden(current => current.includes(code) ? current : [...current, code]);
  }

  return (
    <section className={`fx-converter flex flex-col gap-4${managing ? " is-managing" : ""}`}>
      <header>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-ink">汇率换算</h2>
          <div ref={addMenuRef} className="relative flex items-center gap-2">
            <button type="button" className="fx-converter-add" onClick={() => setAdding(value => !value)} aria-label="新增货币" title="新增货币" aria-expanded={adding}><IconPlus size={15} stroke={1.8} /></button>
            <button type="button" className="fx-converter-refresh" onClick={() => { setAdding(false); void loadRates(true); }} disabled={refreshing} aria-label="刷新汇率" title="刷新汇率"><IconRefresh size={15} stroke={1.8} className={refreshing ? "animate-spin" : ""} /></button>
            <button type="button" className="fx-converter-manage" onClick={() => { setAdding(false); setManaging(value => !value); }} aria-pressed={managing} aria-label={managing ? "完成管理货币" : "管理货币"} title={managing ? "完成管理" : "管理货币"}>{managing ? <IconCheck size={15} stroke={1.8} /> : <IconPencil size={15} stroke={1.8} />}</button>
            {adding && <div className="fx-converter-add-menu" role="menu" aria-label="可新增货币">
              {addableByContinent.map(group => <div key={group.continent} role="group" aria-label={group.continent} className="fx-converter-add-group"><div className="fx-converter-add-heading">{group.continent}</div>{group.items.map(code => { const meta = fxCurrencyMeta(code); return <button key={code} type="button" role="menuitem" onClick={() => addCurrency(code)}>{meta.iso ? <CurrencyFlag market={meta.iso} size={18} /> : <span className="fx-converter-code-mark">{code.slice(0, 1)}</span>}<span>{meta.label}</span><small>{code}</small></button>; })}</div>)}
              {!addable.length && <span className="fx-converter-add-empty">暂无更多可添加的主要货币；可手动刷新汇率后再查看</span>}
            </div>}
          </div>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          输入任一币种金额，其余货币按当前汇率跟随换算 · 拖动手柄可调整顺序
        </p>
        {rateError && <p role="alert" className="mt-1 text-xs text-red-500">{rateError}</p>}
      </header>

      <div className="fx-converter-card">
        {!codes.length && <div className="fx-converter-empty">已移除所有货币，点击上方「＋」重新添加。</div>}
        {codes.map((code, index) => {
          const meta = fxCurrencyMeta(code);
          const live = hasQuote(code);
          const active = code === base && live;
          const converted = !live || !hasQuote(base) ? null : active ? amount : amount == null ? null : convertAmount(amount, base, code, rates);
          const rate = live && hasQuote(base) ? pairRate(base, code, rates) : null;
          return (
            <div
              key={code}
              className={`fx-converter-row${active ? " is-active" : ""}${!live ? " is-missing" : ""}${dragging === index ? " is-dragging" : ""}${over === index && dragging !== index ? " is-over" : ""}`}
              draggable
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest(".drag-handle")) dragFrom.current = index;
              }}
              onDragStart={(event) => {
                if (dragFrom.current !== index) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", code);
                setDragging(index);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (over !== index) setOver(index);
              }}
              onDragLeave={() => {
                if (over === index) setOver(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                onDrop(index);
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setDragging(null);
                setOver(null);
              }}
            >
              <DragHandle label={meta.label} />
              <span className="fx-converter-flag">
                {meta.iso ? <CurrencyFlag market={meta.iso} size={28} /> : <span className="fx-converter-code-mark fx-converter-code-mark-large">{code.slice(0, 1)}</span>}
              </span>
              <label className="fx-converter-body">
                <span className="fx-converter-meta">
                  <span className="fx-converter-name">{meta.label}</span>
                  <span className="fx-converter-code">{code}</span>
                </span>
                <span className="fx-converter-value">
                  <span className="fx-converter-symbol">{meta.symbol}</span>
                  <input
                    ref={(node) => {
                      inputRefs.current[code] = node;
                    }}
                    className="fx-converter-input"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${meta.label}金额`}
                    value={live ? (active ? text : converted == null ? "" : formatFxAmount(converted, code)) : ""}
                    readOnly={!active || !live}
                    placeholder={live ? "" : "暂无汇率"}
                    onMouseDown={() => activate(code)}
                    onFocus={() => {
                      activate(code);
                      requestAnimationFrame(() => inputRefs.current[code]?.select());
                    }}
                    onChange={(event) => setText(sanitizeFxInput(event.target.value))}
                  />
                </span>
              </label>
              <span className="fx-converter-rate">
                {!live
                  ? "暂无汇率"
                  : active
                    ? "正在输入"
                    : rate == null
                      ? "暂无汇率"
                      : `1 ${base} = ${formatPairRate(rate)} ${code}`}
              </span>
              <button type="button" className="fx-converter-remove" aria-label={`移除${meta.label}`} title={`移除${meta.label}`} onClick={() => removeCurrency(code)}><IconX size={13} stroke={1.8} /></button>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted">
        以 1 美元（USD）为基准换算。汇率接口 更新于：{formatRatesDate(updatedAt)}
        {estimatedMop && codes.includes("MOP") && <span> · 澳门元按 1 港元≈1.03 澳门元估算</span>}
      </p>
    </section>
  );
}
