"use client";

import { useEffect, useRef, useState } from "react";
import { IconPencil } from "@tabler/icons-react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import { FUND_CURRENCIES, isFundCurrency, type FundCurrency } from "@/lib/fundCurrencies";
import { showToast } from "@/lib/toast";

type CashState = { balances: Record<FundCurrency, number>; cardCash: Record<string, number> };
const amountText = (value: number) => Number(value.toFixed(8)).toString();

export default function CashBalanceEditor({ preferredCurrency, frozenByCurrency, onSaved }: {
  preferredCurrency: string;
  frozenByCurrency: Partial<Record<FundCurrency, number>>;
  onSaved: (balances: Record<FundCurrency, number>, cardCash: Record<string, number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState<FundCurrency>("USD");
  const [snapshot, setSnapshot] = useState<CashState | null>(null);
  const [frozen, setFrozen] = useState<Partial<Record<FundCurrency, number>>>({});
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/v1/funds?limit=1", { cache: "no-store", signal: controller.signal });
        const json = await res.json();
        if (!res.ok || !json.data?.balances) throw new Error(json.message || "现金余额读取失败");
        if (!controller.signal.aborted) setSnapshot(json.data);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "现金余额读取失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    const balance = snapshot?.balances[currency];
    setAmount(typeof balance === "number" && Number.isFinite(balance) ? amountText(Math.max(0, balance - (frozen[currency] ?? 0))) : "");
  }, [currency, snapshot, frozen]);
  async function save() {
    if (savingRef.current || loading || !snapshot) return;
    const available = Number(amount);
    const expectedBalance = snapshot.balances[currency];
    if (Math.abs((frozenByCurrency[currency] ?? 0) - (frozen[currency] ?? 0)) > 1e-8) {
      setError("冻结现金已变化，请重新打开并核对后保存"); return;
    }
    if (!amount.trim() || !Number.isFinite(available) || available < 0 || available > 1e12 || typeof expectedBalance !== "number" || !Number.isFinite(expectedBalance)) {
      setError("请填写有效的可用现金金额，余额为零请填写 0"); return;
    }
    savingRef.current = true; setSaving(true); setError("");
    try {
      const res = await fetch("/api/v1/funds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_balance", currency, expectedBalance, targetBalance: available + (frozen[currency] ?? 0) }) });
      const json = await res.json();
      if (!res.ok || !json.data?.balances) throw new Error(json.message || "现金余额保存失败");
      onSaved(json.data.balances, json.data.cardCash || {});
      window.dispatchEvent(new Event("fire:records-updated"));
      setOpen(false); showToast("可用现金已更新");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "现金余额保存失败");
    } finally { savingRef.current = false; setSaving(false); }
  }
  return <>
    <button type="button" aria-label="修改可用现金" title="修改可用现金" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-bg-gray hover:text-ink" onClick={() => {
      setCurrency(isFundCurrency(preferredCurrency) ? preferredCurrency : "USD"); setFrozen({ ...frozenByCurrency }); setSnapshot(null); setAmount(""); setError(""); setOpen(true);
    }}><IconPencil className="h-3.5 w-3.5" /></button>
    {open && <AppModal title="修改可用现金" desc="按币种核对实际金额，保存后同步账户总览与资产配置。" onClose={() => setOpen(false)} closeDisabled={saving}>
      <label className="block text-xs text-muted">币种</label>
      <AppSelect ariaLabel="现金币种" value={currency} options={FUND_CURRENCIES.map(value => ({ value, label: value }))} onChange={value => { setCurrency(value as FundCurrency); setError(""); }} disabled={saving || loading} className="mt-1 w-full rounded-lg border border-edge px-3 py-2.5 text-sm" />
      <label htmlFor="cash-balance-amount" className="mt-4 block text-xs text-muted">可用现金（{currency}）</label>
      <input id="cash-balance-amount" data-autofocus type="number" min="0" max="1000000000000" step="any" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setError(""); }} disabled={saving || loading || !snapshot} placeholder={loading ? "读取中…" : "填写实际可用金额"} className="mt-1 w-full rounded-lg border border-edge bg-white px-3 py-2.5 text-sm text-ink outline-none focus:border-brand disabled:opacity-50" />
      <p className="mt-3 text-xs leading-5 text-muted">金额已含该币种银行卡现金，请勿重复相加。保存会记录差额调整，银行卡余额保持原记录。{(frozen[currency] ?? 0) > 0 && ` 当前冻结 ${amountText(frozen[currency]!)} ${currency}，另计入现金余额。`}</p>
      {error && <p role="alert" className="mt-3 text-xs text-down">{error}</p>}
      <div className="mt-5 flex justify-end gap-2.5"><button type="button" disabled={saving} onClick={() => setOpen(false)} className="rounded-lg border border-edge px-4 py-2 text-sm">取消</button><button type="button" disabled={loading || saving || !snapshot || !amount.trim()} onClick={() => void save()} className="rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? "保存中…" : "保存"}</button></div>
    </AppModal>}
  </>;
}
