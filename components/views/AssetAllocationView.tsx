"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconBuildingBank, IconChartPie, IconCoins, IconPlus, IconRefresh, IconEye, IconEyeOff, IconArrowUpRight, IconLink } from "@tabler/icons-react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import CurrencySelect from "@/components/CurrencySelect";
import { marketBadgeKey } from "@/lib/marketBadge";
import MarketCodeBadge from "@/components/MarketCodeBadge";
import SafeAssetImage from "@/components/SafeAssetImage";
import { useDisplayCurrency, CURRENCY_SYMBOLS } from "@/lib/currencyPrefs";
import { usePersistedState } from "@/lib/usePersistedState";
import { clientRequestId } from "@/lib/randomId";
import { allocationCategoryRoute, allocationRoute } from "@/lib/assetAllocationRouting";
import { AllocationClientError, allocationAmountMode, writeAllocation } from "@/lib/assetAllocationClient";
import { useAssetAllocationSnapshot, type AllocationReadEvent } from "@/lib/useAssetAllocationSnapshot";
import { useWorkspaceForeground } from "@/lib/useWorkspaceForeground";
import { ALLOCATION_CATEGORIES, ALLOCATION_LABELS, type AllocationAccount, type AllocationCategory, type AllocationInput, type AllocationSnapshot } from "@/lib/assetAllocationTypes";

function AccountMarketBadges({ account, data }: { account: AllocationAccount; data: AllocationSnapshot }) {
  const positions = data.positions.filter(p => p.accountId === account.id && p.market);
  const badges = new Map(positions.map(p => [marketBadgeKey(p.market!, p.code), p]));
  return <>{[...badges].map(([key, p]) => <MarketCodeBadge alwaysVisible key={key} market={p.market!} code={p.code} />)}</>;
}

// 类别配色唯一来源在 app/globals.css 的 --allocation-* 变量；这里只引用，避免两处定义漂移。
const COLORS: Record<AllocationCategory, string> = { securities: "var(--allocation-securities)", cash: "var(--allocation-cash)", investment: "var(--allocation-investment)", fixed: "var(--allocation-fixed)", receivable: "var(--allocation-receivable)", debt: "var(--allocation-debt)" };
type Wire = { id: string; path: string; forward: string; returning: string; color: string; excluded: boolean };
type ReadPhase = "idle" | "request" | "response" | "error";
type FlowCycle = { id: number; phase: "idle" | "request" | "response" };
const FLOW_DURATION_MS = 3200, FLOW_STAGGER_MS = 120, MAX_FLOW_STAGGER = 6;
const FLOW_PASS_MS = FLOW_DURATION_MS + FLOW_STAGGER_MS * MAX_FLOW_STAGGER;
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

// 逐条比较，避免每次布局都对整组线做两遍 JSON 序列化。
const sameWires = (a: Wire[], b: Wire[]) => a.length === b.length && a.every((wire, index) => {
  const next = b[index];
  return wire.id === next.id && wire.path === next.path && wire.forward === next.forward && wire.returning === next.returning && wire.color === next.color && wire.excluded === next.excluded;
});

// Routing geometry adapted from Magpie's MIT routing stage. See docs/asset-allocation.md.
function RoutingGraph({ data, nodes, hidden, phase, flow, onEdit, onBanks }: { data: AllocationSnapshot; nodes: SourceNode[]; hidden: boolean; phase: ReadPhase; flow: FlowCycle; onEdit: (account: AllocationAccount) => void; onBanks: () => void }) {
  const stage = useRef<HTMLDivElement>(null), hub = useRef<HTMLDivElement>(null), sources = useRef<HTMLDivElement>(null), destinations = useRef<HTMLDivElement>(null);
  const accountNodes = useRef(new Map<string, HTMLElement>()), categoryNodes = useRef(new Map<string, HTMLElement>());
  const [wires, setWires] = useState<Wire[]>([]), [size, setSize] = useState({ width: 1, height: 1 });
  const structure = useMemo(() => JSON.stringify([nodes.map(n => [n.id, n.category, n.excluded]), data.categories.map(c => c.id)]), [nodes, data.categories]);
  const money = (value: number | null) => hidden ? "******" : value === null ? "—" : `${CURRENCY_SYMBOLS[data.currency as keyof typeof CURRENCY_SYMBOLS] || data.currency}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  useLayoutEffect(() => {
    const root = stage.current, center = hub.current; if (!root || !center) return;
    let frame = 0;
    const layout = () => {
      const r = root.getBoundingClientRect(); if (!r.width) return;
      const box = (el: HTMLElement) => { const b = el.getBoundingClientRect(); return { l: b.left - r.left, r: b.right - r.left, t: b.top - r.top, b: b.bottom - r.top, cx: (b.left + b.right) / 2 - r.left, cy: (b.top + b.bottom) / 2 - r.top }; };
      const h = box(center), next: Wire[] = [], visible = sources.current ? box(sources.current) : null;
      const categoryBoxes = new Map([...categoryNodes.current].map(([id, node]) => [id, box(node)]));
      const destinationTop = destinations.current ? box(destinations.current).t : h.b;
      for (const a of nodes) {
        const node = accountNodes.current.get(a.id), t = categoryBoxes.get(a.category); if (!node || !t) continue;
        const s = box(node);
        if (visible && (s.cy < visible.t + 22 || s.cy > visible.b)) continue;
        const route = allocationRoute(s, h, t, destinationTop);
        next.push({ id: a.id, ...route, color: COLORS[a.category], excluded: a.excluded });
      }
      for (const cat of data.categories) {
        const t = categoryBoxes.get(cat.id); if (!t) continue;
        const route = allocationCategoryRoute(h, t, destinationTop);
        next.push({ id: `category:${cat.id}`, path: route.forward, forward: "", returning: "", color: COLORS[cat.id], excluded: false });
      }
      setSize(previous => previous.width === r.width && previous.height === r.height ? previous : { width: r.width, height: r.height });
      setWires(previous => sameWires(previous, next) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    const observer = new ResizeObserver(schedule); observer.observe(root); observer.observe(center);
    for (const n of accountNodes.current.values()) observer.observe(n);
    for (const n of categoryNodes.current.values()) observer.observe(n);
    const sourceColumn = sources.current;
    layout(); window.addEventListener("resize", schedule); sourceColumn?.addEventListener("scroll", schedule, { passive: true });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); sourceColumn?.removeEventListener("scroll", schedule); };
  // Amount/visibility changes are measured by ResizeObserver; only topology rebuilds observers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);
  return <div ref={stage} className={`allocation-stage ${phase === "request" ? "is-reading" : ""} ${flow.phase !== "idle" ? "is-flowing" : ""}`}>
    <svg className="allocation-wires" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {wires.map(w => <path key={w.id} d={w.path} style={{ stroke: w.color }} className={w.excluded ? "is-excluded" : ""} />)}
    </svg>
    <div ref={sources} className="allocation-sources">
      <div className="allocation-column-label">账户来源<span>{nodes.length}</span></div>
      {nodes.map(n => {
        const a = n.account;
        // 正常账户不再显示说明行（原币、持仓数、已核对/自动关联），只在需要留意时给一条提示，降低文字密度。
        const note = !a ? "" : a.excluded ? "未计入" : a.amount === null ? "待补余额" : a.value === null ? "缺汇率" : a.recordIds.some(id => data.quoteStatus.missing.includes(id)) ? "部分记录价" : "";
        return a ? <button key={n.id} ref={el => { if (el) accountNodes.current.set(n.id, el); else accountNodes.current.delete(n.id); }} type="button" className={`allocation-node allocation-account ${n.excluded ? "is-excluded" : ""}`} onClick={() => onEdit(a)}>
        <span className="allocation-node-icon"><SafeAssetImage src={a.icon} style={{ width: 19, height: 19 }} className="rounded object-contain" fallback={a.kind === "broker" ? <IconChartPie size={19} stroke={1.5} /> : a.kind === "bank" ? <IconBuildingBank size={19} stroke={1.5} /> : <IconCoins size={19} stroke={1.5} />} /></span>
        <span className="allocation-node-body"><span className="flex min-w-0 items-center gap-1.5"><b title={a.name}>{a.name}</b><AccountMarketBadges account={a} data={data} /></span>{note ? <small>{note}</small> : null}<strong>{money(a.value)}</strong></span>
        <span className="allocation-node-dot" style={{ background: COLORS[a.category] }} />
      </button> : <button key={n.id} ref={el => { if (el) accountNodes.current.set(n.id, el); else accountNodes.current.delete(n.id); }} type="button" className={`allocation-node allocation-account ${n.excluded ? "is-excluded" : ""}`} onClick={onBanks} aria-label="展开银行卡">
        <span className="allocation-node-icon"><IconBuildingBank size={19} stroke={1.5} /></span>
        <span className="allocation-node-body"><b>银行卡</b><small>{data.bankSummary.count} 张有余额 · 点击展开</small><strong>{money(data.bankSummary.value)}</strong></span>
        <IconArrowUpRight size={13} className="allocation-bank-expand" /><span className="allocation-node-dot" style={{ background: COLORS.cash }} />
      </button>; })}
      {!nodes.length && <div className="allocation-empty">暂无已记录账户</div>}
    </div>
    <div ref={hub} className="allocation-hub allocation-node">
      <strong>{money(data.summary.netAsset)}</strong>
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
  const money = (amount: number | null, currency = data.currency) => hidden ? "******" : amount === null ? "—" : `${CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || currency}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function AccountEditor({ account, positions, accountId, currency, onClose, onSaved, onReload }: { positions: AllocationSnapshot["positions"]; account: AllocationAccount | null; accountId: string; currency: string; onClose: () => void; onSaved: () => void; onReload: () => Promise<AllocationSnapshot | null> }) {
  const [name, setName] = useState(account?.name ?? ""), [amount, setAmount] = useState(account?.amount?.toString() ?? ""), [cur, setCur] = useState(account?.currency ?? currency);
  const [category, setCategory] = useState<AllocationCategory>(account?.category ?? "cash"), [excluded, setExcluded] = useState(account?.excluded ?? false);
  const [saving, setSaving] = useState(false), [error, setError] = useState(""); const busy = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const requestId = useRef<string | null>(null);
  const linked = account !== null && account.kind !== "manual";
  const broker = account?.kind === "broker";
  const mode = allocationAmountMode(account, Number(amount));
  const linkedPositions = positions.filter(p => p.accountId === account?.id);
  async function save(reset = false) {
    if (busy.current || uncertain) return;
    if (!reset && (!name.trim() || !amount.trim() || !Number.isFinite(Number(amount)))) { setError("请填写名称和有效金额"); return; }
    busy.current = true; setSaving(true); setError("");
    try {
      if (!account && !requestId.current) requestId.current = clientRequestId();
      const input: AllocationInput = { ...(account ? { id: account.id } : { requestId: requestId.current! }), revision: account?.revision ?? 0, name, currency: cur, category, amount: Number(amount), excluded, amountMode: mode };
      await writeAllocation(reset ? "DELETE" : account ? "PUT" : "POST", "/api/asset-allocation", accountId, reset ? { id: account?.id, revision: account?.revision } : { ...input });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); setUncertain(e instanceof AllocationClientError && (e.uncertain || e.status === 409)); }
    finally { busy.current = false; setSaving(false); }
  }
  return <AppModal title={account ? "核对账户" : "添加账户"} onClose={onClose} closeDisabled={saving}>
    <form className="allocation-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset className="contents" disabled={saving || uncertain}>
      <label>账户名称<input data-autofocus value={name} maxLength={80} onChange={e => setName(e.target.value)} required /></label>
      <div className="allocation-form-row"><label>资产类别<AppSelect value={category} options={ALLOCATION_CATEGORIES.map(value => ({ value, label: ALLOCATION_LABELS[value] }))} onChange={v => setCategory(v as AllocationCategory)} ariaLabel="资产类别" disabled={linked} /></label>
        <label>币种<AppSelect value={cur} options={[...new Set([cur, "USD", "CNY", "HKD", "SGD", "JPY", "KRW", "EUR", "GBP", "CAD", "AUD"])].map(value => ({ value, label: value }))} onChange={setCur} ariaLabel="账户币种" disabled={linked} /></label></div>
      <label>{broker ? mode === "automatic" ? `自动关联持仓市值（${cur}）` : `账户总权益（含现金，${cur}）` : category === "debt" ? "负债金额" : "当前余额"}<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
      {linked && <p className="allocation-form-note">账户名称仅用于显示，不改变股票市场或原币。核对金额仅用于资产配置，不修改资金账本或资产页可用现金。</p>}
      {broker && <p className="allocation-form-note">{mode === "automatic" ? "当前金额只包含关联持仓，现金由资金账本与银行卡单独计入。修改金额会切换为账户总权益核对。" : `已关联持仓市值 ${account.currency} ${account.holdings?.toLocaleString("en-US") ?? "—"}；与总权益的差额仅作为资产配置中的账户现金，需核对是否与其他现金重复。`}</p>}
      {linkedPositions.length > 0 && <div className="allocation-position-list" aria-label="当前关联持仓"><p className="allocation-form-note">当前关联持仓 · {linkedPositions.length} 项</p>{linkedPositions.map(p => <div key={p.id} className="flex min-w-0 items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-1.5"><b className="truncate text-sm">{p.name}</b>{p.market && <MarketCodeBadge alwaysVisible market={p.market} code={p.code} />}</span><small className="shrink-0 text-muted">{p.code} · {p.currency}</small></div>)}</div>}
      <label className="allocation-checkbox"><input type="checkbox" checked={!excluded} onChange={e => setExcluded(!e.target.checked)} />计入资产配置</label>
      </fieldset>
      {error && <p role="alert" className="allocation-error">{error}</p>}
      <div className="mt-5 flex justify-end gap-2.5">{account?.reconciled && <button type="button" className="allocation-button mr-auto" disabled={saving || uncertain} onClick={() => void save(true)}>{linked ? "恢复自动关联" : "移除账户"}</button>}<button type="button" className="allocation-button" disabled={saving} onClick={onClose}>取消</button>{uncertain ? <button type="button" className="allocation-button is-primary" disabled={saving} onClick={async () => { setSaving(true); if (await onReload()) onClose(); setSaving(false); }}>{saving ? "读取中…" : "重新读取"}</button> : <button type="submit" className="allocation-button is-primary" disabled={saving}>{saving ? "保存中…" : "保存"}</button>}</div>
    </form>
  </AppModal>;
}

function BrokerAssignment({ data, onClose, onSaved, onReload }: { data: AllocationSnapshot; onClose: () => void; onSaved: () => void; onReload: () => Promise<AllocationSnapshot | null> }) {
  const [broker, setBroker] = useState(data.brokers[0]?.id || ""), [selected, setSelected] = useState(new Set<string>()), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const busy = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  async function save() {
    if (busy.current || uncertain || !selected.size || !broker) return; busy.current = true; setSaving(true); setError("");
    try {
      await writeAllocation("POST", "/api/asset-allocation/assign", data.accountId, { brokerId: broker, records: data.positions.filter(p => selected.has(p.id)).map(p => ({ id: p.id, revision: p.revision })) });
      onSaved(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : "关联失败"); setUncertain(e instanceof AllocationClientError && (e.uncertain || e.status === 409)); }
    finally { busy.current = false; setSaving(false); }
  }
  return <AppModal title="关联券商持仓" onClose={onClose} closeDisabled={saving}>
    <div className="allocation-form"><fieldset className="contents" disabled={saving || uncertain}><label>券商<AppSelect ariaLabel="目标券商" value={broker} options={data.brokers.map(b => ({ value: b.id, label: b.name }))} onChange={setBroker} /></label>
      {!data.brokers.length && <p className="allocation-form-note">请先在股票设置中添加券商。</p>}
      <div className="allocation-position-list">{data.positions.map(p => <label key={p.id} className="allocation-checkbox"><input type="checkbox" checked={selected.has(p.id)} onChange={e => setSelected(prev => { const next = new Set(prev); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })} /><span><span className="flex items-center gap-1.5"><b>{p.name}</b>{p.market && <MarketCodeBadge alwaysVisible market={p.market} code={p.code} />}</span><small>{p.code} · {p.currency} · {data.brokers.find(b => b.id === p.brokerId)?.name || "未归属"}</small></span></label>)}</div>
      </fieldset>
      {error && <p className="allocation-error" role="alert">{error}</p>}
      <div className="mt-5 flex justify-end gap-2.5"><button type="button" className="allocation-button" disabled={saving} onClick={onClose}>取消</button>{uncertain ? <button type="button" className="allocation-button is-primary" disabled={saving} onClick={async () => { setSaving(true); if (await onReload()) onClose(); setSaving(false); }}>{saving ? "读取中…" : "重新读取"}</button> : <button type="button" className="allocation-button is-primary" disabled={saving || !selected.size || !broker || selected.size > 200} onClick={() => void save()}>{saving ? "关联中…" : `关联${selected.size ? ` ${selected.size} 项` : ""}`}</button>}</div>
    </div>
  </AppModal>;
}

export default function AssetAllocationView({ initial }: { initial?: AllocationSnapshot | null }) {
  const { currency } = useDisplayCurrency();
  const foreground = useWorkspaceForeground();
  const [hidden, setHidden] = usePersistedState("fire:allocation-hidden", false);
  const [editing, setEditing] = useState<AllocationAccount | null | undefined>(undefined);
  const [assigning, setAssigning] = useState<AllocationSnapshot | null>(null);
  const [banksOpen, setBanksOpen] = useState(false);
  const [flow, setFlow] = useState<FlowCycle>({ id: 0, phase: "idle" });
  const active = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRead = useCallback((event: AllocationReadEvent) => {
    const seq = event.id;
    if (event.phase !== "response") {
      active.current = seq;
      if (timer.current) clearTimeout(timer.current);
      if (returnTimer.current) clearTimeout(returnTimer.current);
      timer.current = null; returnTimer.current = null;
    }
    if (!event.animate || event.phase === "stop" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setFlow({ id: seq, phase: "idle" }); return; }
    if (event.phase === "request") { setFlow({ id: seq, phase: "request" }); return; }
    if (seq !== active.current) return;
    // Visual timing never delays the actual snapshot or saving controls.
    const remaining = event.hadSnapshot ? Math.max(0, FLOW_PASS_MS - (performance.now() - event.startedAt)) : 0;
    const startReturn = () => {
      if (seq !== active.current) return;
      returnTimer.current = null; setFlow({ id: seq, phase: "response" });
      timer.current = setTimeout(() => { if (seq === active.current) { timer.current = null; setFlow({ id: seq, phase: "idle" }); } }, FLOW_PASS_MS + 100);
    };
    if (remaining > 0) returnTimer.current = setTimeout(startReturn, remaining); else startReturn();
  }, []);
  const { data, error, loading, checkedAt, refresh, changingCurrency } = useAssetAllocationSnapshot(currency, foreground, onRead, initial);
  const phase: ReadPhase = loading ? "request" : error ? "error" : "idle";
  useEffect(() => {
    setEditing(undefined); setAssigning(null); setBanksOpen(false);
  }, [currency, data?.accountId]);
  const nodes = useMemo(() => data ? allocationSources(data) : [], [data]);
  const displayCurrency = data?.currency ?? currency;
  const money = (n: number | null | undefined) => hidden ? "******" : n == null ? "—" : `${CURRENCY_SYMBOLS[displayCurrency as keyof typeof CURRENCY_SYMBOLS] || displayCurrency}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <section className="asset-allocation-view">
    <div className="allocation-toolbar"><div><h2>资产配置<span className="allocation-title-dot" /></h2><p aria-live="polite">{data ? `${data.summary.accountCount} 个账户 · ${changingCurrency ? error ? `${data.currency} · 换算失败` : `${data.currency} → ${currency}…` : `${checkedAt ? new Date(checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""} 更新`}` : "关联现有账户"}</p></div>
      <div className="allocation-actions"><CurrencySelect /><button type="button" className="allocation-icon-button" aria-label={hidden ? "显示金额" : "隐藏金额"} onClick={() => setHidden(!hidden)}>{hidden ? <IconEyeOff size={18} /> : <IconEye size={18} />}</button><button type="button" className="allocation-icon-button" aria-label="刷新账户" disabled={loading} onClick={() => void refresh()}><IconRefresh size={18} className={loading ? "animate-spin" : ""} /></button><button className="allocation-button" type="button" disabled={!data?.positions.length || changingCurrency} onClick={() => setAssigning(data)}><IconLink size={15} />关联持仓</button><button className="allocation-button" type="button" disabled={!data || changingCurrency} onClick={() => setEditing(null)}><IconPlus size={15} />添加账户</button></div>
    </div>
    {error && <div className="allocation-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>重试</button></div>}
    {data ? <>
      <div className="allocation-summary"><div><span>已记录总资产</span><strong>{money(data.summary.totalAsset)}</strong></div><div><span>负债</span><strong>{money(data.summary.totalDebt)}</strong></div><div><span>原持仓总资产</span><strong>{money(data.summary.portfolioTotalAsset)}</strong></div><div><span>净资产差额</span><strong>{money(data.summary.difference)}</strong></div></div>
      <div className="allocation-graph-card"><RoutingGraph data={data} nodes={nodes} hidden={hidden} phase={phase} flow={flow} onEdit={setEditing} onBanks={() => setBanksOpen(true)} /></div>
      {!!data.issues.length && <div className="allocation-issues">{data.issues.map((issue, index) => {
        // 一条提示可能牵涉多个账户（例如现金重叠含待归属现金与若干券商），逐个给出核对入口。
        const targets = issue.accountIds.map(id => data.accounts.find(a => a.id === id)).filter((a): a is AllocationAccount => !!a);
        return <div key={`${issue.code}:${index}`}><IconLink size={15} /><span>{issue.message}</span>
          {!!targets.length && <span className="allocation-issue-actions">{targets.map(a => <button key={a.id} type="button" onClick={() => setEditing(a)}>{targets.length > 1 ? a.name : "核对"}<IconArrowUpRight size={13} /></button>)}</span>}
        </div>;
      })}</div>}
      <div className="allocation-account-list"><div className="allocation-list-heading"><h3>账户明细</h3><span>点击账户核对余额</span></div><div className="allocation-table-scroll"><table>
        <thead><tr><th>账户</th><th>来源</th><th>原币余额</th><th>{displayCurrency} 估值</th><th>状态</th></tr></thead>
        <tbody>{nodes.map(n => { const a = n.account; return a ? <tr key={n.id} className={a.excluded ? "is-excluded" : ""}>
          <td><button type="button" onClick={() => setEditing(a)}>{a.name}<AccountMarketBadges account={a} data={data} /><IconArrowUpRight size={13} /></button></td><td>{a.kind === "broker" ? "持仓" : a.kind === "fund" ? "资金系统" : a.kind === "ledger" ? "简化账本" : "手动录入"}</td><td>{hidden ? "******" : `${a.currency} ${a.amount === null ? "—" : a.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`}</td><td>{money(a.value)}</td><td>{a.excluded ? "未计入" : a.reconciled ? "已核对" : a.amount === null ? "待补余额" : a.value === null ? "缺汇率" : "自动关联"}</td>
        </tr> : <tr key={n.id} className={n.excluded ? "is-excluded" : ""}>
          <td><button type="button" onClick={() => setBanksOpen(true)}>银行卡<IconArrowUpRight size={13} /></button></td><td>{data.bankSummary.count} 张有余额</td><td><button type="button" onClick={() => setBanksOpen(true)}>查看明细</button></td><td>{money(data.bankSummary.value)}</td><td>{n.excluded ? "未计入" : data.bankSummary.value === null ? "待核对" : "已关联"}</td>
        </tr>; })}</tbody>
      </table></div></div>
    </> : !error && <div className="allocation-loading" role="status">正在关联账户…</div>}
    {banksOpen && data && <BankCards data={data} hidden={hidden} onClose={() => setBanksOpen(false)} onEdit={account => { setBanksOpen(false); setEditing(account); }} />}
    {editing !== undefined && data && <AccountEditor account={editing} positions={data.positions} accountId={data.accountId} currency={data.currency} onClose={() => setEditing(undefined)} onReload={() => refresh("mutation")} onSaved={() => { window.dispatchEvent(new Event("fire:allocation-updated")); }} />}
    {assigning && <BrokerAssignment data={assigning} onClose={() => setAssigning(null)} onReload={() => refresh("mutation")} onSaved={() => { window.dispatchEvent(new Event("fire:records-updated")); }} />}
  </section>;
}
