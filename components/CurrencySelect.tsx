"use client";

import { useState } from "react";
import { CURRENCIES, type CurrencyCode, useDisplayCurrency } from "@/lib/currencyPrefs";
import CurrencyFlag from "@/components/CurrencyFlag";

/** 全站统一的圆形国旗货币选择器（7 币种；FIRE 页不渲染） */
export default function CurrencySelect({ value, onChange, allowedCodes, align = "right" }: { value?: CurrencyCode; onChange?: (currency: CurrencyCode) => void; allowedCodes?: CurrencyCode[]; align?: "left" | "right" }) {
  const displayCurrency = useDisplayCurrency();
  const [open, setOpen] = useState(false);
  const currency = value ?? displayCurrency.currency;
  const options = allowedCodes?.length ? CURRENCIES.filter((item) => allowedCodes.includes(item.code)) : CURRENCIES;
  const current = options.find((c) => c.code === currency) ?? options[0] ?? CURRENCIES[0];
  const selectCurrency = (next: CurrencyCode) => onChange ? onChange(next) : displayCurrency.setCurrency(next);
  return (
    <div className="relative">
      <button
        type="button"
        title={`显示货币：${current.label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-edge bg-white/70 transition hover:border-edge-strong hover:bg-white dark:border-white/15 dark:bg-white/[0.06] dark:hover:bg-white/10"
      >
        <CurrencyFlag market={current.market} size={22} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute top-full z-50 mt-2 max-h-[min(320px,calc(100vh-96px))] min-w-[160px] overflow-x-hidden overflow-y-auto rounded-xl border border-edge-strong bg-white p-1.5 shadow-pop dark:border-[#2a3140] dark:bg-[#1b2029] ${align === "left" ? "left-0" : "right-0"}`}>
            {options.map((option) => (
              <button
                key={option.code}
                type="button"
                onClick={() => {
                  selectCurrency(option.code);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${currency === option.code ? "bg-[#3297f6]/15 font-bold text-[#3297f6]" : "text-ink hover:bg-bg-gray"}`}
              >
                <span className="flex items-center gap-2">
                  <CurrencyFlag market={option.market} size={18} />
                  {option.label}
                </span>
                <small className="text-muted">{option.code}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
