"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconReceipt, IconSearch, IconTrash } from "@tabler/icons-react";
import { fmtMoney, fmtMoneyAdaptive, localDateKey } from "@/lib/format";
import { showToast } from "@/lib/toast";
import CurrencySelect from "@/components/CurrencySelect";
import FundEntryDialog from "@/components/FundEntryDialog";
import AppModal from "@/components/AppModal";
import RainbowTextInput from "@/components/RainbowTextInput";
import { CURRENCY_SYMBOLS, type CurrencyCode } from "@/lib/currencyPrefs";
import { stripTrailingStockCode } from "@/lib/stockTitle";
import { useRates } from "@/lib/useRates";
import { usePersistedState } from "@/lib/usePersistedState";

type Currency = CurrencyCode;
interface Tx { id: string; currency: Currency; type: string; amount: number; direction: 1 | -1; note: string; occurredAt: string; sourceOrderId?: string | null; stockCode?: string | null; stockName?: string | null }
interface Summary { openingAsset: number; cashNetFlow: number; stockNetFlow: number; otherNetFlow: number }
const TYPE_LABEL: Record<string, string> = { opening: "期初资金", deposit: "转入", withdrawal: "转出", adjustment: "余额调整" };
type RecordAction = "buy" | "sell" | "dividend";
/** 卡包「存钱 / 取钱」联动生成的流水前缀（与 lib/funds.ts 的 CARD_LINK_PREFIX 一致） */
const CARD_LINK_PREFIX = "card-link-";
function recordView(item: Tx): { title: string; action: RecordAction | null; actionLabel: string; automatic: boolean; showNote: boolean } {
  const cardLinked = item.id.startsWith(CARD_LINK_PREFIX);
  if (!item.sourceOrderId) {
    const title = item.type === "deposit" || item.type === "withdrawal" ? item.direction > 0 ? "资金转入" : "资金转出" : TYPE_LABEL[item.type] || "资金变动";
    // 卡包联动流水也标为「自动」：它由卡包那笔余额变动驱动，不能在这里单独删，
    // 但备注要露出来（写的是哪张卡），否则用户不知道这笔钱对应哪张卡
    return { title, action: null, actionLabel: "", automatic: cardLinked, showNote: cardLinked };
  }
  const prefix = item.note.split(" · ")[0];
  const action: RecordAction | null = prefix.startsWith("买入") ? "buy" : prefix.startsWith("卖出") ? "sell" : prefix.startsWith("股息") ? "dividend" : null;
  const name = stripTrailingStockCode(item.stockName || prefix.replace(/^(买入|卖出|股息)\s*/, ""), item.stockCode);
  const actionLabel = action === "buy" ? "买入" : action === "sell" ? "卖出" : action === "dividend" ? "股息" : "";
  return { title: name || actionLabel || prefix, action, actionLabel, automatic: true, showNote: false };
}
function RecordChip({ tone, children }: { tone: RecordAction | "code" | "auto"; children: string }) {
  return <small className={`fund-record-chip fund-record-chip--${tone}`}>{children}</small>;
}
const EMPTY: Record<Currency, number> = { USD: 0, EUR: 0, HKD: 0, CNY: 0, JPY: 0, KRW: 0, SGD: 0 };
const EMPTY_SUMMARY: Record<Currency, Summary> = Object.fromEntries(Object.keys(EMPTY).map((key) => [key, { openingAsset: 0, cashNetFlow: 0, stockNetFlow: 0, otherNetFlow: 0 }])) as Record<Currency, Summary>;
const RECORD_PAGE_SIZE = 30;

export default function FundsPanel({ holdingAssets, balanceOverrides, onBalancesChange }: { holdingAssets: Record<Currency, number>; balanceOverrides?: Partial<Record<Currency, number>>; onBalancesChange: (balances: Record<Currency, number>, cardCash: Record<string, number>) => void }) {
  const rates = useRates();
  const [currency, setCurrency] = usePersistedState<Currency>("fire:funds-display-currency", "USD");
  const [balances, setBalances] = useState<Record<Currency, number>>(EMPTY);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [summaries, setSummaries] = useState<Record<Currency, Summary>>(EMPTY_SUMMARY);
  const [open, setOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsPage, setRecordsPage] = useState(0);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsQuery, setRecordsQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [type, setType] = useState("deposit");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => localDateKey());
  const [saving, setSaving] = useState(false);
  const recordsCache = useRef(new Map<string, { transactions: Tx[]; total: number }>());
  const recordsRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/v1/funds?limit=1", { cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok) return;
    recordsCache.current.clear();
    const next = { ...EMPTY, ...(json?.data?.balances || {}) };
    // 借记卡 / 预付卡余额已由服务端并进 balances，这里额外把原始明细带上去，
    // 资产分析要在「银行卡现金」那一行说明可用现金里有多少来自银行卡
    const cardCash = (json?.data?.cardCash || {}) as Record<string, number>;
    setBalances(next); setSummaries({ ...EMPTY_SUMMARY, ...(json?.data?.summaries || {}) }); onBalancesChange(next, cardCash);
  }, [onBalancesChange]);
  const loadRecords = useCallback(async (_nextCurrency: Currency, page: number, query = "") => {
    const normalizedQuery = query.trim();
    const key = `${page}:${normalizedQuery.toLocaleLowerCase("zh-CN")}`;
    const cached = recordsCache.current.get(key);
    if (cached) {
      setTransactions(cached.transactions);
      setRecordsTotal(cached.total);
      setRecordsLoading(false);
      return;
    }
    recordsRequest.current?.controller.abort();
    const controller = new AbortController();
    const id = (recordsRequest.current?.id || 0) + 1;
    recordsRequest.current = { id, controller };
    setRecordsLoading(true);
    try {
      const offset = page * RECORD_PAGE_SIZE;
      const res = await fetch(`/api/v1/funds?recordsOnly=1&limit=${RECORD_PAGE_SIZE}&offset=${offset}&q=${encodeURIComponent(normalizedQuery)}`, { cache: "no-store", signal: controller.signal });
      const json = await res.json().catch(() => null);
      if (!res.ok || recordsRequest.current?.id !== id) return;
      const nextTransactions = json?.data?.transactions || [];
      const nextTotal = Number(json?.data?.pagination?.total) || 0;
      recordsCache.current.set(key, { transactions: nextTransactions, total: nextTotal });
      setTransactions(nextTransactions);
      setRecordsTotal(nextTotal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) showToast("资金记录搜索失败", "err");
    } finally {
      if (recordsRequest.current?.id === id) setRecordsLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("fire:orders-updated", refresh);
    window.addEventListener("fire:records-updated", refresh);
    return () => {
      window.removeEventListener("fire:orders-updated", refresh);
      window.removeEventListener("fire:records-updated", refresh);
    };
  }, [load]);
  useEffect(() => {
    if (recordsOpen) void loadRecords(currency, recordsPage, debouncedQuery);
  }, [currency, debouncedQuery, loadRecords, recordsOpen, recordsPage]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setRecordsPage(0); setDebouncedQuery(recordsQuery.trim()); }, 120);
    return () => window.clearTimeout(timer);
  }, [recordsQuery]);
  useEffect(() => {
    if (!recordsTotal) return;
    const lastPage = Math.max(0, Math.ceil(recordsTotal / RECORD_PAGE_SIZE) - 1);
    if (recordsPage > lastPage) setRecordsPage(lastPage);
  }, [recordsPage, recordsTotal]);
  const submit = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return showToast("请输入有效金额", "err");
    setSaving(true);
    const normalizedType = type === "deposit" && direction < 0 ? "withdrawal" : type;
    const res = await fetch("/api/v1/funds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currency, type: normalizedType, amount: value, direction, note, occurredAt }) });
    const json = await res.json().catch(() => null); setSaving(false);
    if (!res.ok) return showToast(json?.message || "保存失败", "err");
    setOpen(false); setAmount(""); setNote(""); setOccurredAt(localDateKey()); await load(); showToast("资金记录已保存");
  };
  const remove = async (id: string) => {
    const res = await fetch(`/api/v1/funds/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return showToast("删除失败", "err");
    recordsCache.current.clear();
    await load(); await loadRecords(currency, recordsPage, debouncedQuery);
  };
  const convert = useCallback((value: number, from: Currency) => value / (rates[from] || 1) * (rates[currency] || 1), [currency, rates]);
  const displayedBalances = useMemo(() => ({ ...balances, ...balanceOverrides }), [balances, balanceOverrides]);
  const cash = useMemo(() => (Object.entries(displayedBalances) as [Currency, number][]).reduce((sum, [iso, value]) => sum + convert(value, iso), 0), [displayedBalances, convert]);
  const holdings = useMemo(() => (Object.entries(holdingAssets) as [Currency, number][]).reduce((sum, [iso, value]) => sum + convert(value, iso), 0), [holdingAssets, convert]);
  const currencyTransactions = transactions;
  const { openingAsset, cashNetFlow, stockNetFlow, otherNetFlow } = useMemo(() => (Object.entries(summaries) as [Currency, Summary][]).reduce((total, [iso, summary]) => ({
    openingAsset: total.openingAsset + convert(summary.openingAsset, iso),
    cashNetFlow: total.cashNetFlow + convert(summary.cashNetFlow, iso),
    stockNetFlow: total.stockNetFlow + convert(summary.stockNetFlow, iso),
    otherNetFlow: total.otherNetFlow + convert(summary.otherNetFlow, iso)
  }), { openingAsset: 0, cashNetFlow: 0, stockNetFlow: 0, otherNetFlow: 0 }), [summaries, convert]);
  // 买卖股票只是现金与持仓之间互转，不属于外部投入，否则卖出会被重复计入盈亏。
  const currentInvestment = cashNetFlow + otherNetFlow;
  const endingAsset = cash + holdings;
  const profit = endingAsset - openingAsset - currentInvestment;
  const exactMoney = (value: number, signed = false) => `${signed && value > 0 ? "+" : ""}${fmtMoney(value, CURRENCY_SYMBOLS[currency])}`;
  const cardMoney = (value: number, signed = false) => <>{signed && value > 0 ? "+" : ""}{fmtMoneyAdaptive(value, CURRENCY_SYMBOLS[currency], 1e5)}</>;
  const metric = (label: string, value: number, tone: "plain" | "flow" | "result" = "plain") => <div className={`fund-flow-card fund-flow-card--${tone}`} title={`${label}：${exactMoney(value, tone !== "result")}`}><span className="fund-flow-label">{label}</span><strong className={`fund-flow-value ${tone !== "result" && value !== 0 ? value > 0 ? "text-up" : "text-down" : ""}`}>{cardMoney(value, tone !== "result")}</strong></div>;
  return <section className="funds-panel card overflow-visible">
    <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-4"><div className="min-w-0"><div className="flex items-center gap-2.5"><h3 className="text-base font-bold">资金系统</h3><CurrencySelect value={currency} align="left" onChange={(next) => { setCurrency(next as Currency); setRecordsPage(0); }} /></div><p className="mt-0.5 truncate text-[11px] text-muted">现金与持仓共同构成账户资产</p></div><button type="button" onClick={() => setOpen(true)} className="btn-line h-8 shrink-0 px-3 text-xs"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="mr-1 h-3.5 w-3.5"><path d="M10 4v12M4 10h12" /></svg>记一笔</button></div>
    <div className="p-5">
      <div className="fund-flow-grid">
        <div aria-hidden="true" className="fund-flow-bracket fund-flow-bracket--left" />
        <div aria-hidden="true" className="fund-flow-bracket fund-flow-bracket--right" />
        <div aria-hidden="true" className="fund-flow-center-line fund-flow-center-line--left" />
        <div aria-hidden="true" className="fund-flow-center-line fund-flow-center-line--right" />
        <div className="col-start-1 row-start-1">{metric("现金净流入", cashNetFlow)}</div>
        <div className="col-start-1 row-start-2">{metric("交易现金流", stockNetFlow)}</div>
        <div className="col-start-1 row-start-3">{metric("其他净流入", otherNetFlow)}</div>
        <div className="col-start-2 row-start-1">{metric("期初总资产", openingAsset, "flow")}</div>
        <div className="col-start-2 row-start-2">{metric("当期净投入", currentInvestment, "flow")}</div>
        <div className="col-start-2 row-start-3">{metric("盈亏额", profit, "flow")}</div>
        <div className="col-start-3 row-start-2">{metric("期末总资产", endingAsset, "result")}</div>
      </div>
      <div className="mt-4 text-[10px] leading-4 text-muted"><b className="block text-xs text-ink">温馨提示</b><p>1. 盈亏额 = 期末总资产 − 期初总资产 − 当期净投入。</p><p>2. 买卖与股息属于账户内部现金流，不计入外部投入。</p><p>3. 卡面库「我的卡」里的借记卡 / 预付卡余额也算现金，已并入各币种余额与「其他净流入」；信用卡的金额是额度，不计入。从券商转到卡上（或转回券商）时，在卡包「存钱 / 取钱」弹窗里打开「券商账户」开关，会自动记一笔反向流水，两边不会重复计算。</p><p>4. <button type="button" onClick={() => { setRecordsPage(0); setRecordsOpen(true); }} className="border-b border-dashed border-muted/60 pb-px font-semibold text-muted transition-colors hover:border-ink hover:text-ink">查看资金记录</button></p></div>
    </div>
    {open && <FundEntryDialog currency={currency} setCurrency={setCurrency} direction={direction} setDirection={setDirection} type={type} setType={setType} amount={amount} setAmount={setAmount} occurredAt={occurredAt} setOccurredAt={setOccurredAt} note={note} setNote={setNote} currentBalance={displayedBalances[currency] || 0} saving={saving} onClose={() => setOpen(false)} onSubmit={() => void submit()} />}
    {recordsOpen && <AppModal title="资金记录" desc={`折算为 ${currency} · 共 ${recordsTotal} 笔 · 当前余额 ${fmtMoney(cash, CURRENCY_SYMBOLS[currency])}`} size="md" onClose={() => setRecordsOpen(false)} headerActions={<label className="relative block"><IconSearch size={14} stroke={1.8} className={`pointer-events-none absolute left-3 top-1/2 z-20 -translate-y-1/2 text-muted ${recordsLoading ? "animate-pulse" : ""}`} /><RainbowTextInput autoFocus value={recordsQuery} onChange={(event) => setRecordsQuery(event.target.value)} placeholder="名称、代码、拼音、买入/卖出" className="h-9 w-full rounded-xl border border-edge bg-bg-gray pl-8 pr-8 text-[11px] text-ink outline-none transition-colors focus-within:border-[#3297f6]/60 focus-within:bg-white dark:focus-within:bg-white/5" />{recordsQuery && <button type="button" onClick={() => setRecordsQuery("")} className="absolute right-1.5 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-white hover:text-ink dark:hover:bg-white/10" aria-label="清空搜索">×</button>}</label>}>
      <div className="-mx-3 h-[min(520px,62vh)] overflow-y-auto px-1 sm:-mx-2">
        {recordsLoading && currencyTransactions.length === 0 ? <div className="space-y-2 px-2 py-1">{Array.from({ length: 6 }, (_, index) => <div key={index} className="flex animate-pulse items-center gap-3 rounded-[14px] px-3 py-2.5"><span className="flex-1"><i className="block h-3 w-2/5 rounded bg-bg-gray" /><i className="mt-2 block h-2.5 w-1/4 rounded bg-bg-gray" /></span><i className="h-3 w-20 rounded bg-bg-gray" /></div>)}</div> : currencyTransactions.length ? currencyTransactions.map((item) => {
          const { title, action, actionLabel, automatic, showNote } = recordView(item);
          return <div key={item.id} className="group flex items-center gap-3 rounded-[14px] px-3 py-2.5 transition-colors hover:bg-bg-gray">
            <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><b className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-ink">{title}</b><span className="flex shrink-0 items-center gap-1">{actionLabel && action && <RecordChip tone={action}>{actionLabel}</RecordChip>}{item.stockCode && <RecordChip tone="code">{item.stockCode}</RecordChip>}{automatic && <RecordChip tone="auto">自动</RecordChip>}</span></span><small className="mt-1 block truncate text-[10px] tabular-nums text-muted">{new Date(item.occurredAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}{item.note && (!automatic || showNote) ? ` · ${item.note}` : ""}</small></span>
            <b className={`shrink-0 text-xs tabular-nums ${item.direction > 0 ? "text-up" : "text-down"}`} title={`原币金额 ${fmtMoney(item.amount, CURRENCY_SYMBOLS[item.currency])}`}>{item.direction > 0 ? "+" : "−"}{fmtMoneyAdaptive(convert(item.amount, item.currency), CURRENCY_SYMBOLS[currency], 1e5)}</b>
            {!automatic && <button type="button" onClick={() => void remove(item.id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted opacity-0 transition-all hover:bg-down/10 hover:text-down focus:opacity-100 group-hover:opacity-100" title="删除记录" aria-label="删除资金记录"><IconTrash size={15} stroke={1.7} /></button>}
          </div>;
        }) : <div className="flex min-h-[240px] flex-col items-center justify-center px-6 text-center"><span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-edge bg-bg-gray text-muted">{debouncedQuery ? <IconSearch size={21} stroke={1.6} /> : <IconReceipt size={21} stroke={1.6} />}</span><b className="mt-4 text-sm text-ink">{debouncedQuery ? "没有匹配的资金记录" : "暂无资金记录"}</b><p className="mt-1 text-xs text-muted">{debouncedQuery ? "试试中国移动、zgyd、600941、买入或 9月3日" : "新增资金或完成交易后，记录会显示在这里"}</p></div>}
      </div>
      {recordsTotal > RECORD_PAGE_SIZE && <div className="mt-4 flex items-center justify-between border-t border-edge pt-4"><span className="text-[11px] tabular-nums text-muted">第 {recordsPage + 1} / {Math.ceil(recordsTotal / RECORD_PAGE_SIZE)} 页</span><div className="flex gap-2"><button type="button" disabled={recordsPage === 0 || recordsLoading} onClick={() => setRecordsPage((page) => Math.max(0, page - 1))} className="btn-line h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40">上一页</button><button type="button" disabled={(recordsPage + 1) * RECORD_PAGE_SIZE >= recordsTotal || recordsLoading} onClick={() => setRecordsPage((page) => page + 1)} className="btn-line h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40">下一页</button></div></div>}
    </AppModal>}
  </section>;
}
