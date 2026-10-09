"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import { FUND_CURRENCIES, FUND_CURRENCY_META, isFundCurrency, type FundCurrency } from "@/lib/fundCurrencies";
import { showToast } from "@/lib/toast";
import { fmtMoney } from "@/lib/format";

import { cashAmountText as amountText, cashEditPreview, requestCashState, type CashState } from "@/lib/cashBalanceClient";

export default function CashBalanceEditor({ preferredCurrency, frozenByCurrency, onSaved }: {
  preferredCurrency: string;
  frozenByCurrency: Partial<Record<FundCurrency, number>>;
  onSaved: (balances: Record<FundCurrency, number>, cardCash: Record<string, number>) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const [edited, setEdited] = useState(false);
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState<FundCurrency>("USD");
  const [snapshot, setSnapshot] = useState<CashState | null>(null);
  const [frozen, setFrozen] = useState<Partial<Record<FundCurrency, number>>>({});
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const aliveRef = useRef(false);
  const saveController = useRef<AbortController | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; saveController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setSnapshot(null);
    void (async () => {
      try {
        const next = await requestCashState(undefined, controller.signal);
        if (!controller.signal.aborted) setSnapshot(next);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "现金余额读取失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open, readAttempt]);
  useEffect(() => {
    setEdited(false);
    const balance = snapshot?.balances[currency];
    setAmount(typeof balance === "number" && Number.isFinite(balance) ? amountText(Math.max(0, balance - (frozen[currency] ?? 0))) : "");
  }, [currency, snapshot, frozen]);
  useEffect(() => { if (snapshot && !loading) inputRef.current?.focus({ preventScroll: true }); }, [snapshot, loading]);
  const balance = snapshot?.balances[currency];
  const preview = cashEditPreview(amount, balance, frozen[currency] ?? 0, edited);
  async function save() {
    if (savingRef.current || loading || !snapshot) return;
    const expectedBalance = snapshot.balances[currency];
    if (Math.abs((frozenByCurrency[currency] ?? 0) - (frozen[currency] ?? 0)) > 1e-8) {
      setError("冻结现金已变化，请重新打开并核对后保存"); return;
    }
    if (preview.target === null || typeof expectedBalance !== "number" || !Number.isFinite(expectedBalance)) {
      setError("请填写有效的可用现金金额，余额为零请填写 0"); return;
    }
    if (!preview.changed) return;
    savingRef.current = true; setSaving(true); setError("");
    const controller = new AbortController(); saveController.current = controller;
    try {
      const next = await requestCashState({ currency, expectedBalance, targetBalance: preview.target }, controller.signal);
      if (!aliveRef.current) return;
      onSaved(next.balances, next.cardCash || {});
      window.dispatchEvent(new Event("fire:records-updated"));
      setOpen(false); showToast("可用现金已更新");
    } catch (reason) {
      if (aliveRef.current) setError(reason instanceof Error ? reason.message : "现金余额保存失败");
    } finally { savingRef.current = false; saveController.current = null; if (aliveRef.current) setSaving(false); }
  }
  return <>
    <button type="button" aria-label="修改可用现金" title="修改可用现金" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-bg-gray hover:text-ink" onClick={() => {
      setCurrency(isFundCurrency(preferredCurrency) ? preferredCurrency : "USD"); setFrozen({ ...frozenByCurrency }); setSnapshot(null); setEdited(false); setAmount(""); setError(""); setOpen(true);
    }}><IconPencil className="h-3.5 w-3.5" /></button>
    {open && <AppModal title="修改可用现金" desc="按币种核对实际金额，保存后同步账户总览与资产配置。" onClose={() => setOpen(false)} closeDisabled={saving}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block text-xs text-muted">币种</label>
      <AppSelect ariaLabel="现金币种" value={currency} options={FUND_CURRENCIES.map(value => ({ value, label: `${FUND_CURRENCY_META[value].label} · ${value}` }))} onChange={value => { setCurrency(value as FundCurrency); setEdited(false); setError(""); }} disabled={saving || loading} className="mt-1 w-full rounded-lg border border-edge px-3 py-2.5 text-sm" />
      <label htmlFor={inputId} className="mt-4 block text-xs text-muted">可用现金（{currency}）</label>
      <input id={inputId} ref={inputRef} data-autofocus type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setEdited(true); setError(""); }} disabled={saving || loading || !snapshot} placeholder={loading ? "读取中…" : "填写实际可用金额"} className="mt-1 w-full rounded-lg border border-edge bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-brand disabled:opacity-50" />
      {typeof balance === "number" && Number.isFinite(balance) && <div className="mt-3 rounded-lg bg-bg-gray px-3 py-2 text-xs leading-5 text-muted">
        <div className="flex justify-between gap-3"><span>当前现金余额</span><span className="tabular-nums" title={`${amountText(balance)} ${currency}`}>{fmtMoney(balance, "")} {currency}</span></div>
        {balance < 0 && <p>余额为负，请核对实际可用金额后再保存。</p>}
        {preview.changed && preview.delta !== null && <div className="flex justify-between gap-3"><span>本次调整</span><span className="tabular-nums text-ink" title={`${amountText(preview.delta)} ${currency}`}>{preview.delta > 0 ? "+" : ""}{fmtMoney(preview.delta, "")} {currency}</span></div>}
      </div>}
      <p className="mt-3 text-xs leading-5 text-muted">金额已含该币种银行卡现金，请勿重复相加。保存会记录差额调整，银行卡余额保持原记录。{(frozen[currency] ?? 0) > 0 && ` 当前冻结 ${amountText(frozen[currency]!)} ${currency}，另计入现金余额。`}</p>
      {error && <div className="mt-3"><p role="alert" className="text-xs text-down">{error}</p><button type="button" disabled={loading || saving} onClick={() => { setLoading(true); setSnapshot(null); setEdited(false); setFrozen({ ...frozenByCurrency }); setReadAttempt(value => value + 1); }} className="mt-2 text-xs text-brand underline underline-offset-4">重新读取余额</button></div>}
      <div className="mt-5 flex justify-end gap-2.5"><button type="button" disabled={saving} onClick={() => setOpen(false)} className="rounded-lg border border-edge px-4 py-2 text-sm">取消</button><button type="submit" disabled={loading || saving || !snapshot || !preview.changed} className="rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? "保存中…" : "保存"}</button></div>
      </form>
    </AppModal>}
  </>;
}
