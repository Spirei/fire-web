"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconBuildingBank, IconChartPie, IconCoins, IconPlus, IconRefresh, IconEye, IconEyeOff, IconArrowUpRight, IconLink } from "@tabler/icons-react";
import AppModal from "@/components/AppModal";
import AppSelect from "@/components/AppSelect";
import CurrencySelect from "@/components/CurrencySelect";
import SafeAssetImage from "@/components/SafeAssetImage";
import { useDisplayCurrency, CURRENCY_SYMBOLS } from "@/lib/currencyPrefs";
import { usePersistedState } from "@/lib/usePersistedState";
import { clientRequestId } from "@/lib/randomId";
import { ALLOCATION_CATEGORIES, ALLOCATION_LABELS, type AllocationAccount, type AllocationCategory, type AllocationInput, type AllocationSnapshot } from "@/lib/assetAllocationTypes";

const COLORS: Record<AllocationCategory, string> = { securities: "#8b80c5", cash: "#62a998", investment: "#749ec7", fixed: "#c59b67", receivable: "#a69ac5", debt: "#c78087" };
type Wire = { id: string; path: string; flight: string; returning: string; color: string; excluded: boolean };
type Flight = "idle" | "request" | "response" | "error";

// Routing geometry adapted from Magpie's MIT routing stage. See docs/asset-allocation.md.
function RoutingGraph({ data, hidden, phase, onEdit }: { data: AllocationSnapshot; hidden: boolean; phase: Flight; onEdit: (account: AllocationAccount) => void }) {
  const stage = useRef<HTMLDivElement>(null), hub = useRef<HTMLDivElement>(null), sources = useRef<HTMLDivElement>(null);
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
      for (const a of data.accounts) {
        const node = accountNodes.current.get(a.id), category = categoryNodes.current.get(a.category); if (!node || !category) continue;
        const s = box(node), t = box(category), mx = (s.r + h.l) / 2;
        if (sources.current) { const visible = box(sources.current); if (s.cy < visible.t + 22 || s.cy > visible.b) continue; }
        const left = `M${s.r},${s.cy} C${mx},${s.cy} ${mx},${h.cy} ${h.l},${h.cy}`;
        const leftBack = `C${mx},${h.cy} ${mx},${s.cy} ${s.r},${s.cy}`;
        let right: string, rightBack: string;
        if (t.l > h.r) {
          const rx = (h.r + t.l) / 2;
          right = `C${rx},${h.cy} ${rx},${t.cy} ${t.l},${t.cy}`;
          rightBack = `M${t.l},${t.cy} C${rx},${t.cy} ${rx},${h.cy} ${h.r},${h.cy}`;
        } else {
          const y = t.t - 20;
          right = `L${h.cx},${h.b} L${h.cx},${y} C${h.cx},${t.cy} ${t.l - 16},${y} ${t.l},${t.cy}`;
          rightBack = `M${t.l},${t.cy} C${t.l - 16},${y} ${h.cx},${t.cy} ${h.cx},${y} L${h.cx},${h.b} L${h.r},${h.cy}`;
        }
        next.push({ id: a.id, path: left, flight: `${left} L${h.r},${h.cy} ${right}`, returning: `${rightBack} L${h.l},${h.cy} ${leftBack}`, color: COLORS[a.category], excluded: a.excluded });
      }
      // One output wire per asset category; account traffic uses the same real route.
      for (const cat of data.categories) {
        const node = categoryNodes.current.get(cat.id); if (!node) continue;
        const t = box(node), mx = (h.r + t.l) / 2;
        const path = t.l > h.r ? `M${h.r},${h.cy} C${mx},${h.cy} ${mx},${t.cy} ${t.l},${t.cy}` : `M${h.cx},${h.b} L${h.cx},${t.t - 20} C${h.cx},${t.cy} ${t.l - 16},${t.t - 20} ${t.l},${t.cy}`;
        next.push({ id: `category:${cat.id}`, path, flight: "", returning: "", color: COLORS[cat.id], excluded: false });
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
  }, [data, hidden]);
  return <div ref={stage} className={`allocation-stage ${phase === "request" ? "is-reading" : ""}`}>
    <svg className="allocation-wires" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {wires.map(w => <path key={w.id} d={w.path} stroke={w.color} className={w.excluded ? "is-excluded" : ""} />)}
    </svg>
    <div ref={sources} className="allocation-sources">
      <div className="allocation-column-label">账户来源<span>{data.accounts.length}</span></div>
      {data.accounts.map(a => <button key={a.id} ref={el => { if (el) accountNodes.current.set(a.id, el); else accountNodes.current.delete(a.id); }} type="button" className={`allocation-node allocation-account ${a.excluded ? "is-excluded" : ""}`} onClick={() => onEdit(a)}>
        <span className="allocation-node-icon"><SafeAssetImage src={a.icon} style={{ width: 19, height: 19 }} className="rounded object-contain" fallback={a.kind === "broker" ? <IconChartPie size={19} stroke={1.5} /> : a.kind === "bank" ? <IconBuildingBank size={19} stroke={1.5} /> : <IconCoins size={19} stroke={1.5} />} /></span>
        <span className="allocation-node-body"><b title={a.name}>{a.name}</b><small>{a.currency} · {a.excluded ? "未计入" : a.reconciled ? "已核对" : a.amount === null ? "待补余额" : a.value === null ? "缺汇率" : a.kind === "broker" ? `${a.recordIds.length} 项持仓${a.recordIds.some(id => data.quoteStatus.missing.includes(id)) ? " · 记录价" : ""}` : "自动关联"}</small><strong>{money(a.value)}</strong></span>
        <span className="allocation-node-dot" style={{ background: COLORS[a.category] }} />
      </button>)}
      {!data.accounts.length && <div className="allocation-empty">暂无已记录账户</div>}
    </div>
    <div ref={hub} className="allocation-hub allocation-node">
      <span className="allocation-hub-icon"><IconChartPie size={32} stroke={1.3} /></span>
      <span className="allocation-column-label">已记录净资产</span>
      <strong>{money(data.summary.netAsset)}</strong><span className="allocation-hub-currency">{data.currency}</span>
      <span className={`allocation-status ${phase === "error" ? "has-error" : !data.summary.complete ? "needs-review" : ""}`}><i />{phase === "request" ? "读取账户…" : phase === "error" ? "读取失败" : !data.summary.complete ? "待核对" : data.quoteStatus.pending ? "行情补齐中" : "已关联"}</span>
    </div>
    <div className="allocation-destinations">
      <div className="allocation-column-label">资产分布</div>
      {data.categories.map(c => <div key={c.id} ref={el => { if (el) categoryNodes.current.set(c.id, el); else categoryNodes.current.delete(c.id); }} className="allocation-node allocation-category">
        <span className="allocation-node-dot" style={{ background: COLORS[c.id] }} /><span className="allocation-node-body"><b>{c.name}</b><strong>{money(c.value)}</strong></span>
        <small>{hidden || c.weightPct === null ? "—" : `${c.weightPct.toFixed(1)}%`}</small>
      </div>)}
    </div>
    {phase !== "idle" && phase !== "error" && <svg key={phase} className="allocation-sky" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {wires.filter(w => w.flight && !w.excluded).map((w, index) => <g key={w.id} className="allocation-flier" style={{ color: w.color }}>
        <animateMotion path={phase === "request" ? w.flight : w.returning} dur="1s" begin={`${(index % 5) * .045}s`} rotate="auto" repeatCount={phase === "request" ? "indefinite" : "1"} />
        <g className="allocation-bird" transform={phase === "response" ? "scale(1 -1)" : undefined}><path d="M-14 3 -5 0 Q-2-5 4-2 L8-4 12-2 8 0 Q5 6-2 4 L-14 3Z" fill="currentColor"/><path className="allocation-wing" d="M-2 1 Q-15-7-9-14 Q-1-11 3 0Z" fill="currentColor"/><path d="M-5 2Q0 5 6 1" fill="none" stroke="var(--allocation-paper)" strokeWidth="1.3"/><circle cx="12" cy="-1" r="2" fill="currentColor"/></g>
      </g>)}
    </svg>}
  </div>;
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
  const [data, setData] = useState<AllocationSnapshot | null>(null), [error, setError] = useState(""), [phase, setPhase] = useState<Flight>("idle"), [editing, setEditing] = useState<AllocationAccount | null | undefined>(undefined);
  const [assigning, setAssigning] = useState<AllocationSnapshot | null>(null);
  const active = useRef(0), abort = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null), owner = useRef("");
  const refresh = useCallback(async () => {
    const seq = ++active.current; abort.current?.abort(); if (timer.current) clearTimeout(timer.current);
    const controller = new AbortController(); abort.current = controller; setPhase("request"); setError("");
    try {
      const r = await fetch(`/api/asset-allocation?currency=${currency}`, { signal: controller.signal, cache: "no-store" }), result = await r.json();
      if (seq !== active.current) return;
      if (!r.ok || result.code !== 0) { if (r.status === 401) setData(null); throw new Error(result.message || "读取失败"); }
      if (owner.current && owner.current !== result.data.accountId) { setEditing(undefined); setAssigning(null); }
      owner.current = result.data.accountId;
      setData(result.data); setPhase("response"); timer.current = setTimeout(() => { if (seq === active.current) setPhase("idle"); }, 1250);
    } catch (e) { if (controller.signal.aborted || seq !== active.current) return; setPhase("error"); setError(e instanceof Error ? e.message : "读取失败"); }
  }, [currency]);
  useEffect(() => {
    setData(null); setEditing(undefined); setAssigning(null); void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 30_000);
    return () => { ++active.current; abort.current?.abort(); if (timer.current) clearTimeout(timer.current); clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const money = (n: number | null | undefined) => hidden ? "••••" : n == null ? "—" : `${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return <section className="asset-allocation-view">
    <div className="allocation-toolbar"><div><h2>资产配置<span className="allocation-title-dot" /></h2><p>{data ? `${data.summary.accountCount} 个账户 · ${data.observedAt ? new Date(data.observedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""} 更新` : "关联现有账户"}</p></div>
      <div className="allocation-actions"><CurrencySelect /><button type="button" className="allocation-icon-button" aria-label={hidden ? "显示金额" : "隐藏金额"} onClick={() => setHidden(!hidden)}>{hidden ? <IconEyeOff size={18} /> : <IconEye size={18} />}</button><button type="button" className="allocation-icon-button" aria-label="刷新账户" disabled={phase === "request"} onClick={() => void refresh()}><IconRefresh size={18} className={phase === "request" ? "animate-spin" : ""} /></button><button className="allocation-button" type="button" disabled={!data?.positions.length} onClick={() => setAssigning(data)}><IconLink size={15} />关联持仓</button><button className="allocation-button" type="button" disabled={!data} onClick={() => setEditing(null)}><IconPlus size={15} />添加账户</button></div>
    </div>
    {error && <div className="allocation-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>重试</button></div>}
    {data ? <>
      <div className="allocation-summary"><div><span>已记录总资产</span><strong>{money(data.summary.totalAsset)}</strong></div><div><span>负债</span><strong>{money(data.summary.totalDebt)}</strong></div><div><span>原持仓总资产</span><strong>{money(data.summary.portfolioTotalAsset)}</strong></div><div><span>净资产差额</span><strong>{money(data.summary.difference)}</strong></div></div>
      <div className="allocation-graph-card"><RoutingGraph data={data} hidden={hidden} phase={phase} onEdit={setEditing} /></div>
      {!!data.issues.length && <div className="allocation-issues">{data.issues.map((i, n) => <div key={`${i.code}:${n}`}><IconLink size={15} /><span>{i.message}</span>{i.accountIds[0] && <button type="button" onClick={() => { const a = data.accounts.find(a => a.id === i.accountIds[0]); if (a) setEditing(a); }}>核对<IconArrowUpRight size={13} /></button>}</div>)}</div>}
      <div className="allocation-account-list"><div className="allocation-list-heading"><h3>账户明细</h3><span>点击账户核对余额</span></div><div className="allocation-table-scroll"><table><thead><tr><th>账户</th><th>来源</th><th>原币余额</th><th>{currency} 估值</th><th>状态</th></tr></thead><tbody>{data.accounts.map(a => <tr key={a.id} className={a.excluded ? "is-excluded" : ""}><td><button type="button" onClick={() => setEditing(a)}>{a.name}<IconArrowUpRight size={13} /></button></td><td>{a.kind === "broker" ? "持仓" : a.kind === "bank" ? "银行卡" : a.kind === "fund" ? "资金系统" : a.kind === "ledger" ? "简化账本" : "手动录入"}</td><td>{hidden ? "••••" : `${a.currency} ${a.amount === null ? "—" : a.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}`}</td><td>{money(a.value)}</td><td>{a.excluded ? "未计入" : a.reconciled ? "已核对" : a.amount === null ? "待补余额" : a.value === null ? "缺汇率" : "自动关联"}</td></tr>)}</tbody></table></div></div>
    </> : !error && <div className="allocation-loading" role="status">正在关联账户…</div>}
    {editing !== undefined && data && <AccountEditor account={editing} accountId={data.accountId} currency={currency} onClose={() => setEditing(undefined)} onSaved={() => { void refresh(); window.dispatchEvent(new Event("fire:allocation-updated")); }} />}
    {assigning && <BrokerAssignment data={assigning} onClose={() => setAssigning(null)} onSaved={() => { void refresh(); window.dispatchEvent(new Event("fire:records-updated")); }} />}
  </section>;
}
