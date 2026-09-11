"use client";

import { useState } from "react";
import { CURRENCIES, type CurrencyCode, useDisplayCurrency } from "@/lib/currencyPrefs";
import CurrencyFlag from "@/components/CurrencyFlag";

export interface CurrencySelectOption<T extends string = CurrencyCode> {
  code: T;
  label: string;
  /** 取国旗用的二字码（ISO 3166-1 alpha-2；欧元用 EU） */
  iso: string;
}

/** 全站统一的圆形国旗货币选择器。
 *  默认列全站展示币种（7 种）；资金系统这类币种更多的场景用 options 传自己的清单。 */
export default function CurrencySelect<T extends string = CurrencyCode>({
  value,
  onChange,
  options,
  align = "right"
}: {
  value?: T;
  onChange?: (currency: T) => void;
  options?: CurrencySelectOption<T>[];
  align?: "left" | "right";
}) {
  const displayCurrency = useDisplayCurrency();
  const [open, setOpen] = useState(false);
  const list = options ?? (CURRENCIES.map((item) => ({ code: item.code as T, label: item.label, iso: item.market })) as CurrencySelectOption<T>[]);
  const currency = value ?? (displayCurrency.currency as unknown as T);
  const current = list.find((c) => c.code === currency) ?? list[0];
  if (!current) return null;
  const selectCurrency = (next: T) => (onChange ? onChange(next) : displayCurrency.setCurrency(next as unknown as CurrencyCode));
  return (
    <div className="relative max-w-full flex-none">
      <button
        type="button"
        title={`显示货币：${current.label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-edge bg-white/70 transition hover:border-edge-strong hover:bg-white dark:border-white/15 dark:bg-white/[0.06] dark:hover:bg-white/10"
      >
        <CurrencyFlag market={current.iso} size={22} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={`absolute left-0 top-full z-50 mt-2 max-h-[min(320px,calc(100vh-96px))] w-[160px] max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto rounded-xl border border-edge-strong bg-white p-1.5 shadow-pop dark:border-[#2a3140] dark:bg-[#1b2029] sm:left-auto ${align === "left" ? "sm:left-0" : "sm:right-0"}`}>
            {list.map((option) => (
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
                  <CurrencyFlag market={option.iso} size={18} />
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
