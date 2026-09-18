"use client";

import { useEffect, useRef, useState } from "react";
import CurrencyFlag from "@/components/CurrencyFlag";
import { FUND_CURRENCIES, FUND_CURRENCY_META, isFundCurrency, type FundCurrency } from "@/lib/fundCurrencies";
import { useDisplayCurrency } from "@/lib/currencyPrefs";
import { usePersistedState } from "@/lib/usePersistedState";
import { useRates } from "@/lib/useRates";
import { showToast } from "@/lib/toast";
import {
  amountToDraft,
  convertAmount,
  formatFxAmount,
  formatPairRate,
  moveFxOrder,
  normalizeFxOrder,
  pairRate,
  parseFxAmount,
  sanitizeFxInput
} from "@/lib/fxConvert";

const FX_ORDER_KEY = "fire:fx-order";

function readUrlState(fallback: FundCurrency): { from: FundCurrency; amount: string } {
  if (typeof window === "undefined") return { from: fallback, amount: "100" };
  const params = new URLSearchParams(window.location.search);
  const from = params.get("from");
  const amount = params.get("amount");
  const parsed = amount != null ? parseFxAmount(amount) : 100;
  return {
    from: isFundCurrency(from) ? from : fallback,
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
  const rates = useRates();
  const { currency: displayCurrency } = useDisplayCurrency();
  const start = isFundCurrency(displayCurrency) ? displayCurrency : "USD";
  const [base, setBase] = useState<FundCurrency>(() => readUrlState(start).from);
  const [text, setText] = useState(() => readUrlState(start).amount);
  const [savedOrder, setSavedOrder] = usePersistedState<FundCurrency[]>(FX_ORDER_KEY, [...FUND_CURRENCIES]);
  const codes = normalizeFxOrder(savedOrder);
  const inputRefs = useRef<Partial<Record<FundCurrency, HTMLInputElement | null>>>({});
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

  const amount = parseFxAmount(text);
  const sourceMeta = FUND_CURRENCY_META[base];

  function activate(next: FundCurrency) {
    if (next === base) return;
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
    setSavedOrder(next);
    showToast("顺序已保存");
  }

  return (
    <section className="fx-converter flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-bold text-ink">汇率换算</h2>
        <p className="mt-0.5 text-xs text-muted">
          输入任一币种金额，其余货币按当前汇率跟随换算 · 拖动手柄可调整顺序
        </p>
      </header>

      <div className="fx-converter-card">
        {codes.map((code, index) => {
          const meta = FUND_CURRENCY_META[code];
          const active = code === base;
          const converted = active ? amount : amount == null ? null : convertAmount(amount, base, code, rates);
          const rate = pairRate(base, code, rates);
          return (
            <div
              key={code}
              className={`fx-converter-row${active ? " is-active" : ""}${dragging === index ? " is-dragging" : ""}${over === index && dragging !== index ? " is-over" : ""}`}
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
                <CurrencyFlag market={meta.iso} size={28} />
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
                    value={active ? text : converted == null ? "" : formatFxAmount(converted, code)}
                    readOnly={!active}
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
                {active
                  ? "正在输入"
                  : rate == null
                    ? "暂无汇率"
                    : `1 ${base} = ${formatPairRate(rate)} ${code}`}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted">
        以 1 {sourceMeta.label}（{base}）为基准换算。汇率来自欧洲央行，台币由腾讯外汇补齐，非实时成交价。
      </p>
    </section>
  );
}
