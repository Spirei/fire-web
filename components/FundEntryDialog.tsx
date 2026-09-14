"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CurrencySelect from "@/components/CurrencySelect";
import { fundCurrencyOptions, fundCurrencySymbol, FUND_CURRENCY_META, type FundCurrency } from "@/lib/fundCurrencies";
import { fmtMoneyAdaptive, localDateKey } from "@/lib/format";

interface Props {
  currency: FundCurrency;
  setCurrency: (value: FundCurrency) => void;
  direction: 1 | -1;
  setDirection: (value: 1 | -1) => void;
  type: string;
  setType: (value: string) => void;
  amount: string;
  setAmount: (value: string) => void;
  occurredAt: string;
  setOccurredAt: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
  currentBalance: number;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
}

const TYPE_OPTIONS = [
  { value: "opening", label: "期初资金", hint: "资产基准" },
  { value: "deposit", label: "现金变动", hint: "转入转出" },
  { value: "adjustment", label: "其他调整", hint: "利息费用" }
] as const;
const RAINBOW_DIGIT_COLORS = ["#ff5f6d", "#ff8a4c", "#ffb84d", "#b58aff", "#8077ff", "#4ca9f5", "#37c7da", "#2bc9a5"];

function FundDatePicker({ value, onChange, max }: { value: string; onChange: (value: string) => void; max: string }) {
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : max;
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const [year, mon] = selected.split("-").map(Number);
    return new Date(year, mon - 1, 1);
  });
  const year = month.getFullYear();
  const mon = month.getMonth();
  const firstOffset = (new Date(year, mon, 1).getDay() + 6) % 7;
  const days = new Date(year, mon + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstOffset + 1;
    return day >= 1 && day <= days ? day : null;
  });
  const iso = (day: number) => `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = localDateKey();
  const atLatestMonth = `${year}-${String(mon + 1).padStart(2, "0")}` >= max.slice(0, 7);
  const display = selected.replaceAll("-", "/");
  return <div className="relative">
    <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className={`flex h-10 w-full items-center justify-between rounded-xl border bg-white px-3 text-xs font-semibold transition dark:bg-[#151a23] ${open ? "border-edge-strong" : "border-edge hover:border-edge-strong"}`}>
      <span className="tabular-nums">{display}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-muted"><path d="M7 3v3M17 3v3M4 9h16"/><rect x="4" y="5" width="16" height="16" rx="3"/></svg>
    </button>
    {open && <>
      <button type="button" aria-label="关闭日期选择" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
      <div className="absolute bottom-full right-0 z-50 mb-2 w-[286px] rounded-2xl border border-edge-strong bg-white p-3 shadow-pop dark:border-[#343d4d] dark:bg-[#1d2430]">
        <div className="mb-3 flex items-center justify-between px-1">
          <button type="button" onClick={() => setMonth(new Date(year, mon - 1, 1))} className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-bg-gray hover:text-ink" aria-label="上个月">‹</button>
          <strong className="text-xs tabular-nums">{year} 年 {mon + 1} 月</strong>
          <button type="button" disabled={atLatestMonth} onClick={() => setMonth(new Date(year, mon + 1, 1))} className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-bg-gray hover:text-ink disabled:cursor-not-allowed disabled:opacity-30" aria-label="下个月">›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-[9px] font-semibold text-muted">{["一","二","三","四","五","六","日"].map((item) => <span key={item} className="pb-2">{item}</span>)}</div>
        <div className="grid grid-cols-7 gap-y-1">{cells.map((day, index) => {
          if (!day) return <span key={`blank-${index}`} />;
          const date = iso(day);
          const disabled = date > max;
          const active = date === selected;
          const isToday = date === today;
          return <button key={date} type="button" disabled={disabled} onClick={() => { onChange(date); setOpen(false); }} className={`relative mx-auto flex h-8 w-8 items-center justify-center rounded-full text-[11px] tabular-nums transition ${active ? "bg-[#3297f6] font-bold text-white shadow-sm" : disabled ? "cursor-not-allowed text-faint opacity-35" : "text-ink hover:bg-bg-gray"}`}>{day}{isToday && !active && <i className="absolute bottom-0.5 h-1 w-1 rounded-full bg-[#3297f6]" />}</button>;
        })}</div>
        <div className="mt-3 flex items-center justify-between border-t border-edge px-1 pt-3"><span className="text-[9px] text-muted">未来日期不可选择</span><button type="button" onClick={() => { onChange(today); setMonth(new Date()); setOpen(false); }} className="text-[10px] font-semibold text-[#3297f6] hover:underline">回到今天</button></div>
      </div>
    </>}
  </div>;
}

export default function FundEntryDialog(props: Props) {
  const [amountFocused, setAmountFocused] = useState(false);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const current = FUND_CURRENCY_META[props.currency];
  const symbol = fundCurrencySymbol(props.currency);
  const maxDate = localDateKey();
  const amountValue = Number(props.amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0 && amountValue <= 1e12;
  const displayAmount = props.amount ? amountValue.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "";
  const digitCount = displayAmount.replace(/\D/g, "").length;
  const amountChars = (() => {
    const nodes: Array<{ key: string; character: string; color?: string }> = [];
    let digitIndex = 0;
    for (const character of displayAmount) {
      if (character === ",") {
        nodes.push({ key: `sep-${digitIndex}`, character });
        continue;
      }
      nodes.push({ key: `d-${digitIndex}`, character, color: RAINBOW_DIGIT_COLORS[digitIndex % RAINBOW_DIGIT_COLORS.length] });
      digitIndex += 1;
    }
    return nodes;
  })();
  const updateAmount = (input: string) => {
    const digits = input.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 13);
    props.setAmount(digits);
  };
  const pinAmountCaret = (input: HTMLInputElement) => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  };
  useLayoutEffect(() => {
    const input = amountInputRef.current;
    if (!input || document.activeElement !== input) return;
    pinAmountCaret(input);
  }, [displayAmount]);
  const projectedBalance = props.currentBalance + (amountValid ? amountValue * props.direction : 0);
  const responsiveMoney = (value: number) => fmtMoneyAdaptive(value, symbol);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", closeOnEscape); };
  }, [props.onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") props.onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (!props.saving && amountValid) props.onSubmit(); }} role="dialog" aria-modal="true" aria-labelledby="fund-dialog-title" className="w-full max-w-[420px] overflow-visible rounded-[20px] border border-edge bg-white shadow-2xl dark:bg-[#1b2029]">
        <div className="flex items-start justify-between border-b border-edge px-5 py-4">
          <div><h3 id="fund-dialog-title" className="text-base font-bold">新增资金记录</h3><p className="mt-1 text-[11px] text-muted">记录后将同步更新现金余额与账户净资产</p></div>
          <button type="button" onClick={props.onClose} className="flex h-8 w-8 items-center justify-center rounded-full border border-edge text-lg leading-none text-muted transition hover:bg-bg-gray hover:text-ink" aria-label="关闭">×</button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div>
            <span className="mb-2 block text-[11px] font-semibold text-muted">资金方向</span>
            <div className="grid grid-cols-2 rounded-xl bg-bg-gray p-1 dark:bg-[#141a24]">
              <button type="button" aria-pressed={props.direction > 0} onClick={() => props.setDirection(1)} className={`rounded-[9px] py-2.5 text-xs font-bold transition ${props.direction > 0 ? "bg-white text-up shadow-sm dark:bg-[#282f3b]" : "text-muted"}`}>＋ 资金流入</button>
              <button type="button" aria-pressed={props.direction < 0} onClick={() => props.setDirection(-1)} className={`rounded-[9px] py-2.5 text-xs font-bold transition ${props.direction < 0 ? "bg-white text-down shadow-sm dark:bg-[#282f3b]" : "text-muted"}`}>－ 资金流出</button>
            </div>
          </div>

          <div className="block">
            <span className="mb-2 flex items-center justify-between"><span className="text-[11px] font-semibold text-muted">金额</span><span className="flex items-center gap-2"><small className="font-semibold text-muted">{current.label} · {props.currency}</small><CurrencySelect value={props.currency} options={fundCurrencyOptions()} align="right" onChange={props.setCurrency} /></span></span>
            <span className="fund-amount-field flex h-16 items-center rounded-xl border border-edge bg-white px-4 dark:bg-[#151a23]">
              <b className="mr-2 text-lg text-muted">{symbol}</b>
              <span className="relative h-full min-w-0 flex-1 overflow-hidden">
                <span aria-hidden="true" className="fund-amount-display">
                  <span className="fund-amount-display-text">
                    {displayAmount ? amountChars.map((item) => <span key={item.key} className={item.color ? undefined : "text-muted/70"} style={item.color ? { color: item.color } : undefined}>{item.character}</span>) : <span className="text-faint">0</span>}
                    <i key="caret" className="fund-rainbow-caret" style={{ backgroundColor: RAINBOW_DIGIT_COLORS[digitCount % RAINBOW_DIGIT_COLORS.length], boxShadow: `0 0 9px ${RAINBOW_DIGIT_COLORS[digitCount % RAINBOW_DIGIT_COLORS.length]}`, visibility: amountFocused ? "visible" : "hidden" }} />
                  </span>
                </span>
                <input ref={amountInputRef} aria-label="金额，仅可输入数字" autoFocus value={displayAmount} onFocus={(event) => { setAmountFocused(true); pinAmountCaret(event.currentTarget); }} onClick={(event) => pinAmountCaret(event.currentTarget)} onKeyUp={(event) => pinAmountCaret(event.currentTarget)} onBlur={() => setAmountFocused(false)} onChange={(event) => updateAmount(event.target.value)} onKeyDown={(event) => { if (event.metaKey || event.ctrlKey || event.altKey) return; if (event.key.length === 1 && !/\d/.test(event.key)) event.preventDefault(); }} inputMode="numeric" autoComplete="off" className="fund-amount-input absolute inset-0 z-10 h-full w-full min-w-0 cursor-text border-0 bg-transparent p-0 text-[28px] font-bold leading-none text-transparent caret-transparent tabular-nums outline-none selection:bg-transparent" />
              </span>
              <small className="ml-2 shrink-0 font-semibold text-muted">{props.currency}</small>
            </span>
            <span className="mt-2 grid h-4 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden text-[10px] leading-4" aria-live="polite">
              <span className={`truncate ${props.amount && !amountValid ? "text-down" : "text-muted"}`}>{props.amount && !amountValid ? "请输入 1 至 1 万亿之间的整数金额" : `当前余额 ${responsiveMoney(props.currentBalance)}`}</span>
              <span className="truncate text-muted">记账后 <b className={`font-semibold ${amountValid ? projectedBalance >= props.currentBalance ? "text-up" : "text-down" : "text-ink"}`}>{responsiveMoney(projectedBalance)}</b></span>
            </span>
          </div>

          <div>
            <span className="mb-2 block text-[11px] font-semibold text-muted">资金类型</span>
            <div className="grid grid-cols-3 gap-2">
              {TYPE_OPTIONS.map((option) => <button key={option.value} type="button" aria-pressed={props.type === option.value} onClick={() => props.setType(option.value)} className={`rounded-xl border px-2 py-2.5 text-left transition ${props.type === option.value ? "border-edge-strong bg-bg-gray shadow-sm dark:bg-[#252d39]" : "border-edge hover:bg-bg-gray/60"}`}><b className="block text-[11px]">{option.label}</b><small className="mt-0.5 block text-[9px] text-muted">{option.hint}</small></button>)}
            </div>
          </div>

          <div className="block"><span className="mb-2 block text-[11px] font-semibold text-muted">发生日期</span><FundDatePicker value={props.occurredAt} max={maxDate} onChange={props.setOccurredAt} /></div>

          <label className="block"><span className="mb-2 block text-[11px] font-semibold text-muted">备注 <i className="font-normal not-italic text-faint">选填</i></span><input value={props.note} onChange={(event) => props.setNote(event.target.value)} maxLength={200} placeholder="" className="h-10 w-full rounded-xl border border-edge bg-white px-3 text-sm dark:bg-[#151a23]" /></label>
        </div>

        <div className="flex items-center justify-end gap-2.5 border-t border-edge px-5 py-4">
          <button type="button" onClick={props.onClose} className="rounded-lg px-4 py-2 text-xs font-semibold text-muted transition hover:bg-bg-gray hover:text-ink">取消</button>
          <button type="submit" disabled={props.saving || !amountValid} className="btn-line min-w-[98px] px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40">{props.saving ? "保存中…" : "确认记录"}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
