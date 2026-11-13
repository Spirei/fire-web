"use client";
import { Capsule, IconButton } from "@/components/Capsule";

import { platformRequest, PlatformRequestError } from "@/lib/platformRequest";
import { accountReadHeaders, privateReadEpoch } from "@/lib/privateReadContext";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import { usePrivateReadRevision } from "@/lib/usePrivateReadRevision";
import { convertAccountAmount } from "@/lib/accountCash";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconReceipt, IconSearch, IconTrash } from "@tabler/icons-react";
import { fmtMoney, fmtMoneyAdaptive, localDateKey } from "@/lib/format";
import { showToast } from "@/lib/toast";
import CurrencySelect from "@/components/CurrencySelect";
import FundEntryDialog from "@/components/FundEntryDialog";
import AppModal from "@/components/AppModal";
import RainbowTextInput from "@/components/RainbowTextInput";
import { fundCurrencyOptions, fundCurrencySymbol, FUND_CURRENCIES, type FundCurrency } from "@/lib/fundCurrencies";
import { stripTrailingStockCode } from "@/lib/stockTitle";
import { useRates } from "@/lib/useRates";
import { usePersistedState } from "@/lib/usePersistedState";

type Currency = FundCurrency;
interface Tx { id: string; currency: Currency; type: string; amount: number; direction: 1 | -1; note: string; occurredAt: string; sourceOrderId?: string | null; stockCode?: string | null; stockName?: string | null }
interface Summary { openingAsset: number|null; cashNetFlow: number|null; stockNetFlow: number|null; otherNetFlow: number|null }
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
const EMPTY: Record<Currency, number|null> = Object.fromEntries(FUND_CURRENCIES.map((code) => [code, null])) as Record<Currency, number|null>;
const EMPTY_SUMMARY: Record<Currency, Summary> = Object.fromEntries(FUND_CURRENCIES.map((code) => [code, { openingAsset: null, cashNetFlow: null, stockNetFlow: null, otherNetFlow: null }])) as Record<Currency, Summary>;
const RECORD_PAGE_SIZE = 30;
const BALANCE_RETAIN_MS = 5 * 60_000;

export default function FundsPanel({ ownerId = "", holdingAssets, balanceOverrides, onBalancesChange }: { ownerId?: string; holdingAssets: Record<Currency, number|null>; balanceOverrides?: Partial<Record<Currency, number|null>>; onBalancesChange: (balances: Record<Currency, number|null>, cardCash: Record<string, number|null>) => void }) {
  const rates = useRates();
  const [currency, setCurrency] = usePersistedState<Currency>("fire:funds-display-currency", "USD");
  const [balances, setBalances] = useState<Record<Currency, number|null>>(EMPTY);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [summaries, setSummaries] = useState<Record<Currency, Summary>>(EMPTY_SUMMARY);
  const [open, setOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsPage, setRecordsPage] = useState(0);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordsReadVersion,setRecordsReadVersion] = useState(0);
  const [recordsQuery, setRecordsQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [type, setType] = useState("deposit");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => localDateKey());
  const [saving, setSaving] = useState(false);
  const recordsCache = useRef(new Map<string, { transactions: Tx[]; total: number }>());
  const recordsRequest = useRef<{ controller: AbortController } | null>(null);
  const foreground = useWorkspaceForeground();
  const readRevision = usePrivateReadRevision();
  const [readError,setReadError] = useState("");
  const balanceRequest=useRef<{controller:AbortController;promise:Promise<void>}|null>(null);
  const balanceReceiptAt=useRef<number|null>(null);
  useLayoutEffect(() => {
    balanceReceiptAt.current=null;
    balanceRequest.current?.controller.abort(); balanceRequest.current=null;
    recordsRequest.current?.controller.abort(); recordsRequest.current=null;
    recordsCache.current.clear(); setTransactions([]); setRecordsTotal(0); setRecordsLoading(false);
    setBalances(EMPTY); setSummaries(EMPTY_SUMMARY); setReadError("");
    onBalancesChange(EMPTY,{USD:null});
  },[ownerId,readRevision,onBalancesChange]);
  const load = useCallback((force=false):Promise<void> => {
    if (!foreground) return Promise.resolve();
    if (balanceRequest.current && !force) return balanceRequest.current.promise;
    balanceRequest.current?.controller.abort();
    const controller=new AbortController();
    const epoch=privateReadEpoch();
    const active=()=>!controller.signal.aborted && balanceRequest.current?.controller===controller && privateReadEpoch()===epoch;
    const promise=(async()=>{
      try {
        const json=await platformRequest<{code:number;data:{balances:Record<string,number|null>;cardCash?:Record<string,number|null>;summaries?:Record<Currency,Summary>}}>("/api/v1/funds?limit=1",{signal:controller.signal,headers:accountReadHeaders(ownerId)},10000);
        if (!active()) return;
        if (json.code!==0 || !json.data?.balances || Array.isArray(json.data.balances) || Object.values(json.data.balances).some(value=>value!==null && (typeof value!=="number" || !Number.isFinite(value)))) throw Error("资金数据格式无效");
        recordsCache.current.clear(); setRecordsReadVersion(value=>value+1);
        const next={...EMPTY,...json.data.balances};
        const cash=json.data.cardCash ?? {USD:null};
        balanceReceiptAt.current=Date.now();
        setBalances(next); setSummaries({...EMPTY_SUMMARY,...json.data.summaries}); setReadError(""); onBalancesChange(next,cash);
      } catch (error) {
        if (!active()) return;
        const last=balanceReceiptAt.current,now=Date.now();
        if (!(last!==null && now>=last && now-last<=BALANCE_RETAIN_MS && error instanceof PlatformRequestError && error.transient)) {
          balanceReceiptAt.current=null;
          setBalances(EMPTY); setSummaries(EMPTY_SUMMARY); setTransactions([]); recordsCache.current.clear();
          onBalancesChange(EMPTY,{USD:null});
        }
        setReadError(error instanceof Error?error.message:"资金暂时无法读取");
      } finally { if(balanceRequest.current?.controller===controller)balanceRequest.current=null; }
    })();
    balanceRequest.current={controller,promise}; return promise;
  }, [ownerId,onBalancesChange,foreground]);
  const loadRecords = useCallback(async (_nextCurrency: Currency, page: number, query = "") => {
    recordsRequest.current?.controller.abort(); recordsRequest.current=null;
    const normalizedQuery = query.trim();
    const key = `${page}:${normalizedQuery.toLocaleLowerCase("zh-CN")}`;
    const cached = recordsCache.current.get(key);
    if (cached) {
      setTransactions(cached.transactions);
      setRecordsTotal(cached.total);
      setRecordsLoading(false);
      return;
    }
    const controller = new AbortController();
    recordsRequest.current = { controller };
    setRecordsLoading(true);
    try {
      const offset = page * RECORD_PAGE_SIZE;
      const json = await platformRequest<{data:{transactions:Tx[];pagination:{total:number}}}>(`/api/v1/funds?recordsOnly=1&limit=${RECORD_PAGE_SIZE}&offset=${offset}&q=${encodeURIComponent(normalizedQuery)}`, { signal: controller.signal,headers:accountReadHeaders(ownerId) },10000);
      if (controller.signal.aborted || recordsRequest.current?.controller !== controller) return;
      if (!Array.isArray(json?.data?.transactions) || !Number.isSafeInteger(json.data.pagination?.total) || json.data.pagination.total<0) throw Error("资金记录格式无效");
      const nextTransactions = json.data.transactions;
      const nextTotal = json.data.pagination.total;
      recordsCache.current.set(key, { transactions: nextTransactions, total: nextTotal });
      while (recordsCache.current.size > 20) recordsCache.current.delete(recordsCache.current.keys().next().value!);
      setTransactions(nextTransactions);
      setRecordsTotal(nextTotal);
    } catch (error) {
      if (!controller.signal.aborted) { setTransactions([]); setRecordsTotal(0); showToast("资金记录搜索失败", "err"); }
    } finally {
      if (recordsRequest.current?.controller === controller) setRecordsLoading(false);
    }
  }, [ownerId]);
  useEffect(() => {
    if (!foreground) return;
    void load();
    const refresh = () => {
      // A confirmed financial change retires the old cash scope. A failed
      // background read alone does not erase the last accepted same-scope book.
      balanceReceiptAt.current=null;
      setBalances(EMPTY); setSummaries(EMPTY_SUMMARY); onBalancesChange(EMPTY,{USD:null});
      void load(true);
    };
    window.addEventListener("fire:orders-updated", refresh);
    window.addEventListener("fire:funds-updated", refresh);
    return () => {
      window.removeEventListener("fire:orders-updated", refresh);
      window.removeEventListener("fire:funds-updated", refresh);
      balanceRequest.current?.controller.abort(); recordsRequest.current?.controller.abort();
    };
  }, [load,foreground,readRevision,onBalancesChange]);
  useEffect(() => {
    if (foreground && recordsOpen) void loadRecords(currency, recordsPage, debouncedQuery);
  }, [currency, debouncedQuery, loadRecords, recordsOpen, recordsPage,foreground,readRevision,recordsReadVersion]);
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
    if(!Number.isFinite(displayedBalances[currency])) return showToast("资金来源待核对", "err");
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return showToast("请输入有效金额", "err");
    setSaving(true);
    const normalizedType = type === "deposit" && direction < 0 ? "withdrawal" : type;
    const res = await fetch("/api/v1/funds", { method: "POST", headers: { "Content-Type": "application/json",...accountReadHeaders(ownerId) }, body: JSON.stringify({ currency, type: normalizedType, amount: value, direction, note, occurredAt }) });
    const json = await res.json().catch(() => null); setSaving(false);
    if (!res.ok) return showToast(json?.message || "保存失败", "err");
    window.dispatchEvent(new Event("fire:funds-updated"));
    setOpen(false); setAmount(""); setNote(""); setOccurredAt(localDateKey()); await load(); showToast("资金记录已保存");
  };
  const remove = async (id: string) => {
    const res = await fetch(`/api/v1/funds/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) return showToast("删除失败", "err");
    window.dispatchEvent(new Event("fire:funds-updated"));
    recordsCache.current.clear();
    await load(); await loadRecords(currency, recordsPage, debouncedQuery);
  };
  const convert = useCallback((value: number|null, from: Currency) => typeof value!=='number'?NaN:value === 0 ? 0 : convertAccountAmount(value, from, rates, currency), [currency, rates]);
  const displayedBalances = useMemo(() => ({ ...balances, ...balanceOverrides }), [balances, balanceOverrides]);
  const cash = useMemo(() => (Object.entries(displayedBalances) as [Currency, number|null][]).reduce((sum, [iso, value]) => sum + convert(value, iso), 0), [displayedBalances, convert]);
  const holdings = useMemo(() => (Object.entries(holdingAssets) as [Currency, number|null][]).reduce((sum, [iso, value]) => sum + convert(value, iso), 0), [holdingAssets, convert]);
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
  const exactMoney = (value: number, signed = false) => Number.isFinite(value) ? `${signed && value > 0 ? "+" : ""}${fmtMoney(value, fundCurrencySymbol(currency))}` : "—";
  const cardMoney = (value: number, signed = false) => <>{signed && value > 0 ? "+" : ""}{fmtMoneyAdaptive(value, fundCurrencySymbol(currency), 1e5)}</>;
  const metric = (label: string, value: number, tone: "plain" | "flow" | "result" = "plain") => <div className={`fund-flow-card fund-flow-card--${tone}`} title={`${label}：${exactMoney(value, tone !== "result")}`}><span className="fund-flow-label">{label}</span><strong className={`fund-flow-value ${tone !== "result" && Number.isFinite(value) && value !== 0 ? value > 0 ? "text-up" : "text-down" : ""}`}>{cardMoney(value, tone !== "result")}</strong></div>;
  const calculationNotes = <div className="space-y-2 text-xs leading-relaxed text-muted"><p>盈亏额 = 期末总资产 − 期初总资产 − 当期净投入。</p><p>买卖与股息是账户内部现金流，不计入外部投入。</p><p>借记卡、预付卡余额计入现金；信用卡额度不计入。券商与卡包互转时，启用「券商账户」会同步反向流水，避免重复计算。</p></div>;
  return <section className="funds-panel card overflow-visible">
    {readError && <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3 text-xs text-muted" role="status"><span>{readError}</span><Capsule variant="secondary" size="sm" onClick={()=>void load(true)}>重试</Capsule></div>}
    <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-4"><div className="min-w-0"><div className="flex items-center gap-2.5"><h3 className="text-base font-bold">资金系统</h3><CurrencySelect value={currency} options={fundCurrencyOptions()} align="left" onChange={(next) => { setCurrency(next); setRecordsPage(0); }} /></div><p className="mt-0.5 truncate text-[11px] text-muted">现金与持仓共同构成账户资产</p></div><Capsule variant="secondary" type="button" onClick={() => setOpen(true)} className="h-8 shrink-0 px-3 text-xs"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="mr-1 h-3.5 w-3.5"><path d="M10 4v12M4 10h12" /></svg>记一笔</Capsule></div>
    <div className="p-5">
      <div className="fund-mobile-overview">
        <div className="fund-mobile-total"><span>期末总资产 · {currency}</span><strong title={exactMoney(endingAsset)}>{cardMoney(endingAsset)}</strong></div>
        <dl className="fund-mobile-key-metrics">
          <div><dt>盈亏额</dt><dd className={profit > 0 ? "text-up" : profit < 0 ? "text-down" : ""} title={exactMoney(profit, true)}>{cardMoney(profit, true)}</dd></div>
          <div><dt>当期净投入</dt><dd title={exactMoney(currentInvestment, true)}>{cardMoney(currentInvestment, true)}</dd></div>
        </dl>
        <details className="fund-mobile-breakdown"><summary>资金明细<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary><dl>{([['期初总资产', openingAsset], ['现金净流入', cashNetFlow], ['交易现金流', stockNetFlow], ['其他净流入', otherNetFlow]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={exactMoney(value, true)}>{cardMoney(value, true)}</dd></div>)}</dl></details>
      </div>
      <div className="fund-flow-grid fund-desktop-flow">
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
      <div className="mt-4 hidden md:block"><b className="mb-2 block text-xs text-ink">计算说明</b>{calculationNotes}</div>
      <div className="fund-panel-footer mt-4">
        <details className="fund-calculation-notes md:hidden"><summary>计算说明<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary><div className="pb-3">{calculationNotes}</div></details>
        <button type="button" onClick={() => { setRecordsPage(0); setRecordsOpen(true); }} className="fund-records-link">资金记录<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>
      </div>
    </div>
    {open && <FundEntryDialog currency={currency} setCurrency={setCurrency} direction={direction} setDirection={setDirection} type={type} setType={setType} amount={amount} setAmount={setAmount} occurredAt={occurredAt} setOccurredAt={setOccurredAt} note={note} setNote={setNote} currentBalance={displayedBalances[currency] ?? NaN} saving={saving} onClose={() => setOpen(false)} onSubmit={() => void submit()} />}
    {recordsOpen && <AppModal title="资金记录" desc={`折算为 ${currency} · 共 ${recordsTotal} 笔 · 当前余额 ${fmtMoney(cash, fundCurrencySymbol(currency))}`} size="md" className="fund-records-modal" onClose={() => setRecordsOpen(false)} headerActions={<label className="relative block"><IconSearch size={14} stroke={1.8} className={`pointer-events-none absolute left-3 top-1/2 z-20 -translate-y-1/2 text-muted ${recordsLoading ? "animate-pulse" : ""}`} /><RainbowTextInput autoFocus value={recordsQuery} onChange={(event) => setRecordsQuery(event.target.value)} placeholder="名称、代码、拼音、买入/卖出" className="h-9 w-full rounded-xl border border-edge bg-bg-gray pl-8 pr-8 text-[11px] text-ink outline-none transition-colors focus-within:border-[#3297f6]/60 focus-within:bg-white dark:focus-within:bg-white/5" />{recordsQuery && <button type="button" onClick={() => setRecordsQuery("")} className="absolute right-1.5 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-white hover:text-ink dark:hover:bg-white/10" aria-label="清空搜索">×</button>}</label>}>
      <div className="fund-records-list -mx-3 max-h-[min(380px,42dvh)] overflow-y-auto px-1 sm:-mx-2 sm:max-h-[520px]">
        {recordsLoading && currencyTransactions.length === 0 ? <div className="space-y-2 px-2 py-1">{Array.from({ length: 6 }, (_, index) => <div key={index} className="flex animate-pulse items-center gap-3 rounded-[14px] px-3 py-2.5"><span className="flex-1"><i className="block h-3 w-2/5 rounded bg-bg-gray" /><i className="mt-2 block h-2.5 w-1/4 rounded bg-bg-gray" /></span><i className="h-3 w-20 rounded bg-bg-gray" /></div>)}</div> : currencyTransactions.length ? currencyTransactions.map((item) => {
          const { title, action, actionLabel, automatic, showNote } = recordView(item);
          return <div key={item.id} className="group flex items-center gap-2 rounded-[14px] px-2 py-2.5 transition-colors hover:bg-bg-gray sm:gap-3 sm:px-3">
            <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5 sm:gap-2"><b title={title} className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-ink">{title}</b><span className="flex shrink-0 items-center gap-1">{actionLabel && action && <RecordChip tone={action}>{actionLabel}</RecordChip>}<span className="hidden items-center gap-1 sm:flex">{item.stockCode && <RecordChip tone="code">{item.stockCode}</RecordChip>}{automatic && <RecordChip tone="auto">自动</RecordChip>}</span></span></span><small className="mt-1 block truncate text-[10px] tabular-nums text-muted">{new Date(item.occurredAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}{item.stockCode && <span className="sm:hidden"> · {item.stockCode}</span>}{item.note && (!automatic || showNote) ? ` · ${item.note}` : ""}</small></span>
            <b className={`shrink-0 text-xs tabular-nums ${item.direction > 0 ? "text-up" : "text-down"}`} title={`原币金额 ${fmtMoney(item.amount, fundCurrencySymbol(item.currency))}`}>{item.direction > 0 ? "+" : "−"}{fmtMoneyAdaptive(convert(item.amount, item.currency), fundCurrencySymbol(currency), 1e5)}</b>
            {!automatic && <IconButton size="sm" tone="danger" type="button" onClick={() => void remove(item.id)} className="opacity-0 focus:opacity-100 group-hover:opacity-100" title="删除记录" label="删除资金记录"><IconTrash size={15} stroke={1.7} /></IconButton>}
          </div>;
        }) : <div className="flex min-h-[min(180px,30dvh)] flex-col items-center justify-center px-6 text-center sm:min-h-[240px]"><span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-edge bg-bg-gray text-muted">{debouncedQuery ? <IconSearch size={21} stroke={1.6} /> : <IconReceipt size={21} stroke={1.6} />}</span><b className="mt-4 text-sm text-ink">{debouncedQuery ? "没有匹配的资金记录" : "暂无资金记录"}</b><p className="mt-1 text-xs text-muted">{debouncedQuery ? "试试中国移动、zgyd、600941、买入或 9月3日" : "新增资金或完成交易后，记录会显示在这里"}</p></div>}
      </div>
      {recordsTotal > RECORD_PAGE_SIZE && <div className="mt-4 flex items-center justify-between border-t border-edge pt-4"><span className="text-[11px] tabular-nums text-muted">第 {recordsPage + 1} / {Math.ceil(recordsTotal / RECORD_PAGE_SIZE)} 页</span><div className="flex gap-2"><Capsule variant="secondary" type="button" disabled={recordsPage === 0 || recordsLoading} onClick={() => setRecordsPage((page) => Math.max(0, page - 1))} className="h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40">上一页</Capsule><Capsule variant="secondary" type="button" disabled={(recordsPage + 1) * RECORD_PAGE_SIZE >= recordsTotal || recordsLoading} onClick={() => setRecordsPage((page) => page + 1)} className="h-8 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-40">下一页</Capsule></div></div>}
    </AppModal>}
  </section>;
}
