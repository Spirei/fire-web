"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconBuildingBank, IconChartPie, IconCoins, IconPlus, IconRefresh, IconEye, IconEyeOff, IconArrowUpRight, IconLink } from "@tabler/icons-react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import CurrencySelect from "@/components/CurrencySelect";
import SafeAssetImage from "@/components/SafeAssetImage";
import { useDisplayCurrency, CURRENCY_SYMBOLS } from "@/lib/currencyPrefs";
import { usePersistedState } from "@/lib/usePersistedState";
import { clientRequestId } from "@/lib/randomId";
import { allocationCategoryRoute, allocationRoute } from "@/lib/assetAllocationRouting";
import { ALLOCATION_CATEGORIES, ALLOCATION_LABELS, type AllocationAccount, type AllocationCategory, type AllocationInput, type AllocationSnapshot } from "@/lib/assetAllocationTypes";

const COLORS: Record<AllocationCategory, string> = { securities: "#8b80c5", cash: "#62a998", investment: "#749ec7", fixed: "#c59b67", receivable: "#a69ac5", debt: "#c78087" };
type Wire = { id: string; path: string; forward: string; returning: string; color: string; excluded: boolean };
type ReadPhase = "idle" | "request" | "response" | "error";
type FlowCycle = { id: number; phase: "idle" | "request" | "response" };
const FLOW_DURATION_MS = 3200, FLOW_STAGGER_MS = 120, MAX_FLOW_STAGGER = 6;
const FLOW_PASS_MS = FLOW_DURATION_MS + FLOW_STAGGER_MS * MAX_FLOW_STAGGER;
const REFRESH_INTERVAL_MS = 30_000;
type SourceNode = { id: string; category: AllocationCategory; excluded: boolean; account: AllocationAccount | null };
function allocationSources(data: AllocationSnapshot): SourceNode[] {
  let bankAdded = false;
  return data.accounts.flatMap<SourceNode>(a => {
    if (a.kind !== "bank") return [{ id: a.id, category: a.category, excluded: a.excluded, account: a }];
    if (bankAdded) return [];
    bankAdded = true;
    return [{ id: "group:bank", category: "cash" as const, excluded: data.bankSummary.includedCount === 0, account: null }];
  });
}

// Routing geometry adapted from Magpie's MIT routing stage. See docs/asset-allocation.md.
function RoutingGraph({ data, nodes, hidden, phase, flow, onEdit, onBanks }: { data: AllocationSnapshot; nodes: SourceNode[]; hidden: boolean; phase: ReadPhase; flow: FlowCycle; onEdit: (account: AllocationAccount) => void; onBanks: () => void }) {
  const stage = useRef<HTMLDivElement>(null), hub = useRef<HTMLDivElement>(null), sources = useRef<HTMLDivElement>(null), destinations = useRef<HTMLDivElement>(null);
  const accountNodes = useRef(new Map<string, HTMLElement>()), categoryNodes = useRef(new Map<string, HTMLElement>());
  const [wires, setWires] = useState<Wire[]>([]), [size, setSize] = useState({ width: 1, height: 1 });
  const money = (value: number | null) => hidden ? "••••" : value === null ? "—" : `${CURRENCY_SYMBOLS[data.currency as keyof typeof CURRENCY_SYMBOLS] || data.currency}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  useLayoutEffect(() => {
    const root = stage.current, center = hub.current; if (!root || !center) return;
    let frame = 0;
    const layout = () => {
      const r = root.getBoundingClientRect(); if (!r.width) return;
      const box = (el: HTMLElement) => { const b = el.getBoundingClientRect(); return { l: b.left - r.left, r: b.right - r.left, t: b.top - r.top, b: b.bottom - r.top, cx: (b.left + b.right) / 2 - r.left, cy: (b.top + b.bottom) / 2 - r.top }; };
      const h = box(center), next: Wire[] = [];
      for (const a of nodes) {
        const node = accountNodes.current.get(a.id), category = categoryNodes.current.get(a.category); if (!node || !category) continue;
        const s = box(node), t = box(category);
        if (sources.current) { const visible = box(sources.current); if (s.cy < visible.t + 22 || s.cy > visible.b) continue; }
        const route = allocationRoute(s, h, t, destinations.current ? box(destinations.current).t : t.t - 20);
        next.push({ id: a.id, ...route, color: COLORS[a.category], excluded: a.excluded });
      }
      for (const cat of data.categories) {
        const node = categoryNodes.current.get(cat.id); if (!node) continue;
        const t = box(node), route = allocationCategoryRoute(h, t, destinations.current ? box(destinations.current).t : t.t - 20);
        next.push({ id: `category:${cat.id}`, path: route.forward, forward: "", returning: "", color: COLORS[cat.id], excluded: false });
      }
      setSize({ width: r.width, height: r.height }); setWires(next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(center);
    for (const n of accountNodes.current.values()) observer.observe(n);
    for (const n of categoryNodes.current.values()) observer.observe(n);
    const sourceColumn = sources.current;
    layout(); window.addEventListener("resize", schedule); sourceColumn?.addEventListener("scroll", schedule, { passive: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); sourceColumn?.removeEventListener("scroll", schedule); };
  }, [data, nodes, hidden]);
  return <div ref={stage} className={`allocation-stage ${phase === "request" ? "is-reading" : ""} ${flow.phase !== "idle" ? "is-flowing" : ""}`}>
    <svg className="allocation-wires" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {wires.map(w => <path key={w.id} d={w.path} stroke={w.color} className={w.excluded ? "is-excluded" : ""} />)}
    </svg>
    <div ref={sources} className="allocation-sources">
      <div className="allocation-column-label">账户来源<span>{nodes.length}</span></div>
      {nodes.map(n => { const a = n.account; return a ? <button key={n.id} ref={el => { if (el) accountNodes.current.set(n.id, el); else accountNodes.current.delete(n.id); }} type="button" className={`allocation-node allocation-account ${n.excluded ? "is-excluded" : ""}`} onClick={() => onEdit(a)}>
        <span className="allocation-node-icon"><SafeAssetImage src={a.icon} style={{ width: 19, height: 19 }} className="rounded object-contain" fallback={a.kind === "broker" ? <IconChartPie size={19} stroke={1.5} /> : a.kind === "bank" ? <IconBuildingBank size={19} stroke={1.5} /> : <IconCoins size={19} stroke={1.5} />} /></span>
        <span className="allocation-node-body"><b title={a.name}>{a.name}</b><small>{a.currency} · {a.excluded ? "未计入" : a.reconciled ? "已核对" : a.amount === null ? "待补余额" : a.value === null ? "缺汇率" : a.kind === "broker" ? `${a.recordIds.length} 项持仓${a.recordIds.some(id => data.quoteStatus.missing.includes(id)) ? " · 记录价" : ""}` : "自动关联"}</small><strong>{money(a.value)}</strong></span>
        <span className="allocation-node-dot" style={{ background: COLORS[a.category] }} />
      </button> : <button key={n.id} ref={el => { if (el) accountNodes.current.set(n.id, el); else accountNodes.current.delete(n.id); }} type="button" className={`allocation-node allocation-account ${n.excluded ? "is-excluded" : ""}`} onClick={onBanks} aria-label="展开银行卡">
        <span className="allocation-node-icon"><IconBuildingBank size={19} stroke={1.5} /></span>
        <span className="allocation-node-body"><b>银行卡</b><small>{data.bankSummary.count} 张有余额 · 点击展开</small><strong>{money(data.bankSummary.value)}</strong></span>
        <IconArrowUpRight size={13} className="allocation-bank-expand" /><span className="allocation-node-dot" style={{ background: COLORS.cash }} />
      </button>; })}
      {!nodes.length && <div className="allocation-empty">暂无已记录账户</div>}
    </div>
    <div ref={hub} className="allocation-hub allocation-node">
      <span className="allocation-hub-icon"><IconChartPie size={32} stroke={1.3} /></span>
      <span className="allocation-column-label">已记录净资产</span>
      <strong>{money(data.summary.netAsset)}</strong><span className="allocation-hub-currency">{data.currency}</span>
      <span className={`allocation-status ${phase === "error" ? "has-error" : !data.summary.complete ? "needs-review" : ""}`}><i />{phase === "request" ? "读取账户…" : phase === "error" ? "读取失败" : !data.summary.complete ? "待核对" : data.quoteStatus.pending ? "行情补齐中" : "已关联"}</span>
    </div>
    <div ref={destinations} className="allocation-destinations">
      <div className="allocation-column-label">资产分布</div>
      {data.categories.map(c => <div key={c.id} ref={el => { if (el) categoryNodes.current.set(c.id, el); else categoryNodes.current.delete(c.id); }} className="allocation-node allocation-category">
        <span className="allocation-node-dot" style={{ background: COLORS[c.id] }} /><span className="allocation-node-body"><b>{c.name}</b><strong>{money(c.value)}</strong></span>
        <small>{hidden || c.weightPct === null ? "—" : `${c.weightPct.toFixed(1)}%`}</small>
      </div>)}
    </div>
    {flow.phase !== "idle" && <svg key={`${flow.id}:${flow.phase}`} className="allocation-flow" data-flow-phase={flow.phase} data-flow-cycle={flow.id} viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {wires.filter(w => w.forward && !w.excluded).map((w, index) => <g key={w.id} className="allocation-pulse" style={{ color: w.color, animationDuration: `${FLOW_DURATION_MS}ms`, animationDelay: `${Math.min(index, MAX_FLOW_STAGGER) * FLOW_STAGGER_MS}ms` }}>
        <animateMotion path={flow.phase === "request" ? w.forward : w.returning} dur={`${FLOW_DURATION_MS}ms`} begin={`${Math.min(index, MAX_FLOW_STAGGER) * FLOW_STAGGER_MS}ms`} rotate="auto" repeatCount="1" fill="freeze" />
        <circle cx="-13" r=".9" fill="currentColor" opacity=".12" />
        <circle cx="-9" r="1.3" fill="currentColor" opacity=".25" />
        <circle cx="-5" r="1.8" fill="currentColor" opacity=".5" />
        <circle r="7" fill="currentColor" className="allocation-pulse-halo" />
        <circle r="4.5" fill="currentColor" opacity=".16" />
        <circle r="2.7" fill="currentColor" />
      </g>)}
    </svg>}
  </div>;
}

function BankCards({ data, hidden, onClose, onEdit }: { data: AllocationSnapshot; hidden: boolean; onClose: () => void; onEdit: (account: AllocationAccount) => void }) {
  const banks = data.accounts.filter(a => a.kind === "bank");
  const money = (amount: number | null, currency = data.currency) => hidden ? "••••" : amount === null ? "—" : `${CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || currency}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <AppModal title="银行卡" onClose={onClose}>
    <div className="allocation-bank-panel">
    <div className="allocation-bank-summary"><span>{data.bankSummary.includedCount} 张计入资产</span><strong>{money(data.bankSummary.value)}</strong></div>
    <div className="allocation-bank-list">{banks.map(a => <button key={a.id} type="button" className={`allocation-bank-detail ${a.excluded ? "is-excluded" : ""}`} onClick={() => onEdit(a)}>
      <span className="allocation-node-icon"><IconBuildingBank size={19} stroke={1.5} /></span>
      <span className="allocation-node-body"><b>{a.name}</b><small>{a.currency} · {a.excluded ? "未计入" : a.reconciled ? "已核对" : a.amount === null ? "余额异常" : a.value === null ? "缺汇率" : "自动关联"}</small><strong>{money(a.amount, a.currency)}{a.currency !== data.currency && <small> ≈ {money(a.value)}</small>}</strong></span>
      <span className="allocation-bank-edit">核对<IconArrowUpRight size={13} /></span>
    </button>)}</div>
    {!banks.length && <p className="allocation-empty">暂无有余额的银行卡</p>}
    </div>
  </AppModal>;
}

function AccountEditor({ account, accountId, currency, onClose, onSaved }: { account: AllocationAccount | null; accountId: string; currency: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(account?.name ?? ""), [amount, setAmount] = useState(account?.amount?.toString() ?? ""), [cur, setCur] = useState(account?.currency ?? currency);
  const [category, setCategory] = useState<AllocationCategory>(account?.category ?? "cash"), [excluded, setExcluded] = useState(account?.excluded ?? false);
  const [saving, setSaving] = useState(false), [error, setError] = useState(""); const busy = useRef(false);
  const requestId = useRef<string | null>(null);
  const linked = account !== null && account.kind !== "manual";
  async function save(reset = false) {
    if (busy.current) return;
    if (!reset && (!name.trim() || !amount.trim() || !Number.isFinite(Number(amount)))) { setError("请填写名称和有效金额"); return; }
    busy.current = true; setSaving(true); setError("");
    try {
      if (!account && !requestId.current) requestId.current = clientRequestId();
      const input: AllocationInput = { ...(account ? { id: account.id } : { requestId: requestId.current! }), revision: account?.revision ?? 0, name, currency: cur, category, amount: Number(amount), excluded };
      const r = await fetch("/api/asset-allocation", { method: reset ? "DELETE" : account ? "PUT" : "POST", headers: { "Content-Type": "application/json", "X-Allocation-User": accountId }, body: JSON.stringify(reset ? { id: account?.id, revision: account?.revision } : input) });
      const result = await r.json(); if (!r.ok || result.code !== 0) throw new Error(result.message || "保存失败");
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { busy.current = false; setSaving(false); }
  }
  return <AppModal title={account ? "核对账户" : "添加账户"} onClose={onClose} closeDisabled={saving}>
    <form className="allocation-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <label>账户名称<input data-autofocus value={name} maxLength={80} onChange={e => setName(e.target.value)} required /></label>
      <div className="allocation-form-row"><label>资产类别<AppSelect value={category} options={ALLOCATION_CATEGORIES.map(value => ({ value, label: ALLOCATION_LABELS[value] }))} onChange={v => setCategory(v as AllocationCategory)} ariaLabel="资产类别" disabled={linked} /></label>
        <label>币种<AppSelect value={cur} options={[...new Set([cur, "USD", "CNY", "HKD", "SGD", "JPY", "KRW", "EUR", "GBP", "CAD", "AUD"])].map(value => ({ value, label: value }))} onChange={setCur} ariaLabel="账户币种" disabled={linked} /></label></div>
      <label>{account?.kind === "broker" ? "账户总权益（含现金）" : category === "debt" ? "负债金额" : "当前余额"}<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
      {linked && <p className="allocation-form-note">核对金额仅用于资产配置；恢复自动关联后继续使用原账本余额。</p>}
      {account?.kind === "broker" && <p className="allocation-form-note">已关联持仓市值 {account.currency} {account.holdings?.toLocaleString("en-US") ?? "—"}。现金由总权益减去持仓得出。</p>}
      <label className="allocation-checkbox"><input type="checkbox" checked={!excluded} onChange={e => setExcluded(!e.target.checked)} />计入资产配置</label>
      {error && <p role="alert" className="allocation-error">{error}</p>}
      <div className="mt-5 flex justify-end gap-2.5">{account?.reconciled && <button type="button" className="allocation-button mr-auto" disabled={saving} onClick={() => void save(true)}>{linked ? "恢复自动关联" : "移除账户"}</button>}<button type="button" className="allocation-button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="allocation-button is-primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
    </form>
  </AppModal>;
}

function BrokerAssignment({ data, onClose, onSaved }: { data: AllocationSnapshot; onClose: () => void; onSaved: () => void }) {
  const [broker, setBroker] = useState(data.brokers[0]?.id || ""), [selected, setSelected] = useState(new Set<string>()), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const busy = useRef(false);
  async function save() {
    if (busy.current || !selected.size || !broker) return; busy.current = true; setSaving(true); setError("");
    try {
      const r = await fetch("/api/asset-allocation/assign", { method: "POST", headers: { "Content-Type": "application/json", "X-Allocation-User": data.accountId }, body: JSON.stringify({ brokerId: broker, records: data.positions.filter(p => selected.has(p.id)).map(p => ({ id: p.id, revision: p.revision })) }) });
      const result = await r.json(); if (!r.ok || result.code !== 0) throw new Error(result.message || "关联失败");
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "关联失败"); }
    finally { busy.current = false; setSaving(false); }
  }
  return <AppModal title="关联券商持仓" onClose={onClose} closeDisabled={saving}>
    <div className="allocation-form"><label>券商<AppSelect ariaLabel="目标券商" value={broker} options={data.brokers.map(b => ({ value: b.id, label: b.name }))} onChange={setBroker} /></label>
      {!data.brokers.length && <p className="allocation-form-note">请先在股票设置中添加券商。</p>}
      <div className="allocation-position-list">{data.positions.map(p => <label key={p.id} className="allocation-checkbox"><input type="checkbox" checked={selected.has(p.id)} onChange={e => setSelected(prev => { const next = new Set(prev); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })} /><span><b>{p.name}</b><small>{p.code} · {p.currency} · {data.brokers.find(b => b.id === p.brokerId)?.name || "未归属"}</small></span></label>)}</div>
      {error && <p className="allocation-error" role="alert">{error}</p>}
      <div className="mt-5 flex justify-end gap-2.5"><button type="button" className="allocation-button" disabled={saving} onClick={onClose}>取消</button><button type="button" className="allocation-button is-primary" disabled={saving || !selected.size || !broker || selected.size > 200} onClick={() => void save()}>{saving ? "关联中…" : `关联${selected.size ? ` ${selected.size} 项` : ""}`}</button></div>
    </div>
  </AppModal>;
}

export default function AssetAllocationView() {
  const { currency, symbol } = useDisplayCurrency();
  const [hidden, setHidden] = usePersistedState("fire:allocation-hidden", false);
  const [data, setData] = useState<AllocationSnapshot | null>(null), [error, setError] = useState(""), [phase, setPhase] = useState<ReadPhase>("idle"), [editing, setEditing] = useState<AllocationAccount | null | undefined>(undefined);
  const [assigning, setAssigning] = useState<AllocationSnapshot | null>(null);
  const [banksOpen, setBanksOpen] = useState(false);
  const [flow, setFlow] = useState<FlowCycle>({ id: 0, phase: "idle" });
  const active = useRef(0), abort = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null), owner = useRef("");
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null), snapshot = useRef<AllocationSnapshot | null>(null);
  const lastRefresh = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++active.current; abort.current?.abort(); if (timer.current) clearTimeout(timer.current);
    if (returnTimer.current) clearTimeout(returnTimer.current);
    timer.current = null; returnTimer.current = null;
    lastRefresh.current = Date.now();
    const startedAt = performance.now(), previous = snapshot.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const controller = new AbortController(); abort.current = controller; setPhase("request"); setError("");
    setFlow({ id: seq, phase: reducedMotion ? "idle" : "request" });
    try {
      const r = await fetch(`/api/asset-allocation?currency=${currency}`, { signal: controller.signal, cache: "no-store" }), result = await r.json();
      if (seq !== active.current) return;
      if (!r.ok || result.code !== 0) { if (r.status === 401) { snapshot.current = null; setData(null); } throw new Error(result.message || "读取失败"); }
      if (owner.current && owner.current !== result.data.accountId) { setEditing(undefined); setAssigning(null); setBanksOpen(false); }
      owner.current = result.data.accountId;
      snapshot.current = result.data; setData(result.data); setPhase("response");
      if (reducedMotion) { setPhase("idle"); return; }
      // Only the return pulse waits for the outbound pass; balances and read status update above.
      const remaining = previous?.accountId === result.data.accountId ? Math.max(0, FLOW_PASS_MS - (performance.now() - startedAt)) : 0;
      const startReturn = () => {
        if (seq !== active.current) return;
        returnTimer.current = null; setFlow({ id: seq, phase: "response" });
        timer.current = setTimeout(() => { if (seq === active.current) { timer.current = null; setFlow({ id: seq, phase: "idle" }); setPhase("idle"); } }, FLOW_PASS_MS + 100);
      };
      if (remaining > 0) returnTimer.current = setTimeout(startReturn, remaining); else startReturn();
    } catch (e) { if (controller.signal.aborted || seq !== active.current) return; setFlow({ id: seq, phase: "idle" }); setPhase("error"); setError(e instanceof Error ? e.message : "读取失败"); }
  }, [currency]);
  useEffect(() => {
    snapshot.current = null; setData(null); setEditing(undefined); setAssigning(null); setBanksOpen(false); void refresh();
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - lastRefresh.current >= REFRESH_INTERVAL_MS) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(onVisible, REFRESH_INTERVAL_MS);
    return () => { ++active.current; abort.current?.abort(); if (timer.current) clearTimeout(timer.current); if (returnTimer.current) clearTimeout(returnTimer.current); clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const nodes = useMemo(() => data ? allocationSources(data) : [], [data]);
  const money = (n: number | null | undefined) => hidden ? "••••" : n == null ? "—" : `${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <section className="asset-allocation-view">
    <div className="allocation-toolbar"><div><h2>资产配置<span className="allocation-title-dot" /></h2><p>{data ? `${data.summary.accountCount} 个账户 · ${data.observedAt ? new Date(data.observedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""} 更新` : "关联现有账户"}</p></div>
      <div className="allocation-actions"><CurrencySelect /><button type="button" className="allocation-icon-button" aria-label={hidden ? "显示金额" : "隐藏金额"} onClick={() => setHidden(!hidden)}>{hidden ? <IconEyeOff size={18} /> : <IconEye size={18} />}</button><button type="button" className="allocation-icon-button" aria-label="刷新账户" disabled={phase === "request"} onClick={() => void refresh()}><IconRefresh size={18} className={phase === "request" ? "animate-spin" : ""} /></button><button className="allocation-button" type="button" disabled={!data?.positions.length} onClick={() => setAssigning(data)}><IconLink size={15} />关联持仓</button><button className="allocation-button" type="button" disabled={!data} onClick={() => setEditing(null)}><IconPlus size={15} />添加账户</button></div>
    </div>
    {error && <div className="allocation-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>重试</button></div>}
    {data ? <>
      <div className="allocation-summary"><div><span>已记录总资产</span><strong>{money(data.summary.totalAsset)}</strong></div><div><span>负债</span><strong>{money(data.summary.totalDebt)}</strong></div><div><span>原持仓总资产</span><strong>{money(data.summary.portfolioTotalAsset)}</strong></div><div><span>净资产差额</span><strong>{money(data.summary.difference)}</strong></div></div>
      <div className="allocation-graph-card"><RoutingGraph data={data} nodes={nodes} hidden={hidden} phase={phase} flow={flow} onEdit={setEditing} onBanks={() => setBanksOpen(true)} /></div>
      {!!data.issues.length && <div className="allocation-issues">{data.issues.map((i, n) => <div key={`${i.code}:${n}`}><IconLink size={15} /><span>{i.message}</span>{i.accountIds[0] && <button type="button" onClick={() => { const a = data.accounts.find(a => a.id === i.accountIds[0]); if (a) setEditing(a); }}>核对<IconArrowUpRight size={13} /></button>}</div>)}</div>}
      <div className="allocation-account-list"><div className="allocation-list-heading"><h3>账户明细</h3><span>点击账户核对余额</span></div><div className="allocation-table-scroll"><table>
        <thead><tr><th>账户</th><th>来源</th><th>原币余额</th><th>{currency} 估值</th><th>状态</th></tr></thead>
        <tbody>{nodes.map(n => { const a = n.account; return a ? <tr key={n.id} className={a.excluded ? "is-excluded" : ""}>
          <td><button type="button" onClick={() => setEditing(a)}>{a.name}<IconArrowUpRight size={13} /></button></td><td>{a.kind === "broker" ? "持仓" : a.kind === "fund" ? "资金系统" : a.kind === "ledger" ? "简化账本" : "手动录入"}</td><td>{hidden ? "••••" : `${a.currency} ${a.amount === null ? "—" : a.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`}</td><td>{money(a.value)}</td><td>{a.excluded ? "未计入" : a.reconciled ? "已核对" : a.amount === null ? "待补余额" : a.value === null ? "缺汇率" : "自动关联"}</td>
        </tr> : <tr key={n.id} className={n.excluded ? "is-excluded" : ""}>
          <td><button type="button" onClick={() => setBanksOpen(true)}>银行卡<IconArrowUpRight size={13} /></button></td><td>{data.bankSummary.count} 张有余额</td><td><button type="button" onClick={() => setBanksOpen(true)}>查看明细</button></td><td>{money(data.bankSummary.value)}</td><td>{n.excluded ? "未计入" : data.bankSummary.value === null ? "待核对" : "已关联"}</td>
        </tr>; })}</tbody>
      </table></div></div>
    </> : !error && <div className="allocation-loading" role="status">正在关联账户…</div>}
    {banksOpen && data && <BankCards data={data} hidden={hidden} onClose={() => setBanksOpen(false)} onEdit={account => { setBanksOpen(false); setEditing(account); }} />}
    {editing !== undefined && data && <AccountEditor account={editing} accountId={data.accountId} currency={currency} onClose={() => setEditing(undefined)} onSaved={() => { void refresh(); window.dispatchEvent(new Event("fire:allocation-updated")); }} />}
    {assigning && <BrokerAssignment data={assigning} onClose={() => setAssigning(null)} onSaved={() => { void refresh(); window.dispatchEvent(new Event("fire:records-updated")); }} />}
  </section>;
}
