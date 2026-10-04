"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { IconArrowLeft, IconArrowUpRight, IconChevronLeft, IconChevronRight, IconRefresh, IconSearch, IconBox, IconX, IconChevronDown, IconChartCandle } from "@tabler/icons-react";
import { useWorkspaceActive, useWorkspaceLocationGuard, useWorkspaceSearchParams } from "@/lib/workspacePanel";
import { POOL_LABELS, POOL_STATES, poolKey, poolQuery, poolSlots, tokenPose, type PoolBootstrap, type PoolEntry, type PoolState } from "@/lib/quotePoolView";
import { useQuotePoolSnapshot } from "@/lib/useQuotePoolSnapshot";
import { QUOTE_DEMAND_MARKETS } from "@/lib/quoteDemand";
import MarketIcon from "@/components/MarketIcon";
import SafeAssetImage from "@/components/SafeAssetImage";

function StockIcon({ entry, size = 38 }: { entry: PoolEntry; size?: number }) {
  const letter = entry.name && entry.name !== entry.code ? [...entry.name.trim()][0] : "";
  return <span className="pool-stock-icon" style={{ width: size, height: size }} aria-hidden="true">
    <SafeAssetImage src={entry.icon} className="pool-stock-image" style={{ width: "100%", height: "100%" }} showFallbackWhileLoading={false}
      fallback={<span className="pool-stock-fallback">{letter || <IconChartCandle size={20} stroke={1.5} />}</span>} />
  </span>;
}

function StorageBox({ entries, selected, onSelect, onMore, replay, live }: {
  entries: PoolEntry[]; selected?: string; onSelect: (key: string) => void; onMore: () => void; replay: number; live: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const tokens = entries.filter(entry => entry.state !== "candidate"), keys = tokens.map(poolKey);
  const signature = JSON.stringify([keys, selected]);
  const allocate = (desktop: Array<string | null>, mobile: Array<string | null>) => {
    const next = poolSlots(keys, desktop, 18, selected);
    return { signature, desktop: next, mobile: poolSlots(next.filter((key): key is string => !!key), mobile, 12, selected) };
  };
  const [layout, setLayout] = useState(() => allocate([], []));
  // Adjust this component's own state before committing a frame, never mutate refs in render.
  const current = layout.signature === signature ? layout : allocate(layout.desktop, layout.mobile);
  if (current !== layout) setLayout(current);
  const byKey = new Map(tokens.map(entry => [poolKey(entry), entry]));
  const shown = current.desktop.flatMap((key, index) => key && byKey.has(key) ? [{ entry: byKey.get(key)!, index, mobile: current.mobile.indexOf(key) }] : []);
  const mobileCount = current.mobile.filter(Boolean).length;
  return <div className="pool-stage" data-live={live} aria-label={`收纳盒，${tokens.length} 个已入池标的`}>
    <div className="pool-stage-orbit" aria-hidden="true" />
    <svg className="pool-box-art" viewBox="0 0 600 400" preserveAspectRatio="none" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}-rim`} x1="65" y1="92" x2="515" y2="356" gradientUnits="userSpaceOnUse"><stop stopColor="#e4c5a1" /><stop offset=".55" stopColor="#cfa980" /><stop offset="1" stopColor="#dcb88f" /></linearGradient>
        <linearGradient id={`${uid}-floor`} x1="300" y1="138" x2="300" y2="330" gradientUnits="userSpaceOnUse"><stop stopColor="#cfab84" /><stop offset=".32" stopColor="#e3c7a8" /><stop offset="1" stopColor="#ead3b9" /></linearGradient>
        <linearGradient id={`${uid}-back`} x1="300" y1="95" x2="300" y2="155" gradientUnits="userSpaceOnUse"><stop stopColor="#b38c64" /><stop offset="1" stopColor="#c49e74" /></linearGradient>
        <linearGradient id={`${uid}-side`}><stop stopColor="#cba57d" /><stop offset="1" stopColor="#b68e64" /></linearGradient>
        <linearGradient id={`${uid}-front`} x1="300" y1="314" x2="300" y2="359" gradientUnits="userSpaceOnUse"><stop stopColor="#f0d9ba" /><stop offset="1" stopColor="#d5ad82" /></linearGradient>
        <filter id={`${uid}-shadow`} x="-30%" y="-40%" width="160%" height="190%"><feGaussianBlur stdDeviation="14" /></filter>
        <filter id={`${uid}-paper`}><feTurbulence type="fractalNoise" baseFrequency=".78" numOctaves="3" seed="4" /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncA type="linear" slope=".055" /></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply" /></filter>
      </defs>
      <rect x="72" y="111" width="456" height="252" rx="27" fill="#6c442c" opacity=".18" filter={`url(#${uid}-shadow)`} />
      <g filter={`url(#${uid}-paper)`}>
        <rect x="62" y="90" width="476" height="266" rx="20" fill={`url(#${uid}-rim)`} />
        <path d="M73 101H527L489 149H111Z" fill={`url(#${uid}-back)`} />
        <path d="M73 101 111 149V307L73 345Z" fill={`url(#${uid}-side)`} />
        <path d="M527 101 489 149V307L527 345Z" fill="#c49c72" />
        <path d="M111 149H489V307H111Z" fill={`url(#${uid}-floor)`} />
        <path d="M111 149H489M111 149V307M489 149V307" stroke="#8e6845" strokeOpacity=".17" strokeWidth="2" />
        <path d="m73 101 38 48m416-48-38 48m-416 196 38-38m416 38-38-38" stroke="#9e734c" strokeOpacity=".25" />
        <path d="M73 345 111 307H489L527 345Z" fill={`url(#${uid}-front)`} />
        <rect x="65" y="93" width="470" height="260" rx="17" stroke="#f8e9d3" strokeOpacity=".65" strokeWidth="2" />
      </g>
      <text x="300" y="338" textAnchor="middle" className="pool-box-wordmark">ALCOR · STOCK COLLECTION</text>
    </svg>
    <div className="pool-box-tokens" key={replay}>
      {shown.map(({ entry, index, mobile }) => {
        const key = poolKey(entry), pose = tokenPose(key, index), mobilePose = tokenPose(key, Math.max(0, mobile));
        return <div key={key} className="pool-token-slot" data-mobile={mobile >= 0} style={{ "--token-x": `${pose.x}%`, "--token-y": `${pose.y}%`, "--token-mx": `${mobilePose.mobileX}%`, "--token-my": `${mobilePose.mobileY}%`, "--token-r": `${pose.rotation}deg`, "--token-mr": `${pose.rotation * .4}deg`, "--token-delay": `${pose.delay}ms` } as CSSProperties}>
          <button type="button" className={`pool-token ${selected === key ? "is-selected" : ""}`} onClick={() => onSelect(key)} title={`${entry.name || entry.code} · ${entry.code}`} aria-label={`${entry.name || entry.code} ${entry.code}，${POOL_STATES[entry.state]}`} aria-pressed={selected === key} data-capsule="off">
            <StockIcon entry={entry} /><span className="pool-token-code">{entry.code}</span><i className={`pool-token-dot is-${entry.state}`} />
          </button>
        </div>;
      })}
    </div>
    {tokens.length === 0 && <div className="pool-box-empty"><IconBox size={25} stroke={1.3} /><span>{entries.length ? "等待入池" : "盒子还是空的"}</span></div>}
    {tokens.length > shown.length && <button type="button" className="pool-box-overflow pool-overflow-desktop" onClick={onMore} aria-label={`查看全部 ${tokens.length} 个已入池股票`}>+{tokens.length - shown.length}</button>}
    {tokens.length > mobileCount && <button type="button" className="pool-box-overflow pool-overflow-mobile" onClick={onMore} aria-label={`查看全部 ${tokens.length} 个已入池股票`}>+{tokens.length - mobileCount}</button>}
  </div>;
}

const timeText = (at: number) => new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const remaining = (end: number, at: number) => { const hours = Math.max(0, (end - at) / 3_600_000); return hours >= 24 ? `${Math.ceil(hours / 24)} 天` : hours >= 1 ? `${Math.ceil(hours)} 小时` : "不足 1 小时"; };

export default function QuotePoolView({ initial, admin, onNavigate }: { initial?: PoolBootstrap | null; admin: boolean; onNavigate: (path: string) => void }) {
  const active = useWorkspaceActive(), locationGuard = useWorkspaceLocationGuard(), params = useWorkspaceSearchParams();
  const view = poolQuery(params, admin);
  const { snapshot, visible, busy, error, refresh } = useQuotePoolSnapshot(initial, view.scope, active);
  const [replay, setReplay] = useState(0), [searchDraft, setSearchDraft] = useState<string | null>(null);
  const composing = useRef(false), inventory = useRef<HTMLElement>(null);
  const selected = (params.get("stock") ?? "").replace(".", ":"), entries = snapshot?.entries ?? [];
  const update = (changes: Record<string, string | undefined>) => {
    if (!locationGuard()) return;
    const query = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) { if (value) query.set(key, value); else query.delete(key); }
    if (!Object.hasOwn(changes, "p")) query.delete("p");
    if (["m", "s", "q", "scope", "p"].some(key => Object.hasOwn(changes, key)) && !Object.hasOwn(changes, "stock")) query.delete("stock");
    window.history.replaceState(null, "", window.location.pathname + (query.size ? `?${query}` : ""));
  };
  const marketEntries = useMemo(() => entries.filter(row => view.market === "ALL" || row.market === view.market), [entries, view.market]);
  const searched = marketEntries.filter(row => !view.query || `${row.code} ${row.name}`.toLowerCase().includes(view.query.toLowerCase()));
  const filtered = searched.filter(row => view.state === "all" || row.state === view.state);
  const counts = (state: PoolState) => searched.filter(row => row.state === state).length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / 12)), page = Math.min(view.page, totalPages), pageRows = filtered.slice((page - 1) * 12, page * 12);
  const detail = filtered.find(row => poolKey(row) === selected);
  const enter = (entry: PoolEntry) => { if (entry.market !== "ASSET") onNavigate(`/watchlist/${entry.market}.${entry.code}`); };
  const choose = (key: string) => update({ stock: selected === key ? undefined : key.replace(":", "."), p: params.get("p") || undefined });
  const showInventory = () => { inventory.current?.scrollIntoView({ block: "start" }); inventory.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!active || !detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && locationGuard()) {
      const query = new URLSearchParams(window.location.search); query.delete("stock");
      window.history.replaceState(null, "", window.location.pathname + (query.size ? `?${query}` : ""));
    } };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [active, detail, locationGuard]);
  return <div className="quote-pool-page">
    <header className="pool-page-header">
      <div><button className="pool-back" type="button" onClick={() => onNavigate("/global")}><IconArrowLeft size={15} />全球经济</button><h1>股票池<span className="pool-title-dot" /></h1></div>
      {admin && <div className="pool-scope" aria-label="查看范围">{(["shared", "mine"] as const).map(scope => <button key={scope} type="button" aria-pressed={view.scope === scope} className={`fire-cap ${view.scope === scope ? "is-active" : ""}`} onClick={() => { update({ stock: undefined, scope: scope === "shared" ? undefined : scope }); }}>{scope === "shared" ? "共享池" : "我的订阅"}</button>)}</div>}
    </header>
    <nav className="pool-markets" aria-label="股票池市场">
      {["ALL", ...QUOTE_DEMAND_MARKETS].map(market => <button key={market} type="button" className={`fire-cap ${view.market === market ? "is-active" : ""}`} aria-pressed={view.market === market} onClick={() => { update({ stock: undefined, m: market === "ALL" ? undefined : market }); }}>
        {market !== "ALL" && market !== "ASSET" && <MarketIcon market={market} size={19} />}<span>{market === "ALL" ? "全部" : POOL_LABELS[market]}</span><small>{entries.filter(row => market === "ALL" || row.market === market).length}</small>
      </button>)}
    </nav>
    <section className="pool-collection">
      <div className="pool-collection-header"><div><span className="pool-eyebrow">THE COLLECTION</span><h2>行情收纳盒</h2></div><div className="pool-collection-actions"><span>保留 <strong>7</strong> 天</span><button type="button" onClick={() => setReplay(value => value + 1)} disabled={!filtered.some(row => row.state !== "candidate")} aria-label="重播股票入盒动效" title="重播入盒"><IconBox size={18} stroke={1.6} /></button></div></div>
      <StorageBox key={`${view.scope}:${view.market}:${view.state}:${view.query}`} entries={filtered} selected={selected} onSelect={choose} onMore={showInventory} replay={replay} live={active && visible} />
      {detail && <div className="pool-selection">
        <StockIcon entry={detail} size={34} /><div><strong>{detail.name || detail.code}</strong><span>{detail.code} · {POOL_LABELS[detail.market]}</span></div>
        <span className={`pool-status is-${detail.state}`}><i />{POOL_STATES[detail.state]}</span>
        {detail.market !== "ASSET" && <button type="button" onClick={() => enter(detail)} aria-label={`查看 ${detail.name || detail.code} 详情`}><IconArrowUpRight size={19} /></button>}
        <button className="pool-selection-close" type="button" onClick={() => choose(poolKey(detail))} aria-label="关闭股票信息"><IconX size={16} /></button>
      </div>}
      <div className="pool-summary"><div><strong>{searched.filter(row => row.state !== "candidate").length}<span>支</span></strong><span>已入池</span></div>{(["hot", "dormant", "candidate"] as const).map(state => <button type="button" key={state} className={view.state === state ? "is-active" : ""} aria-pressed={view.state === state} onClick={() => update({ s: view.state === state ? undefined : state })}><span className={`pool-status is-${state}`}><i />{POOL_STATES[state]}</span><strong>{counts(state)}</strong></button>)}</div>
    </section>
    <section className="pool-inventory" ref={inventory} tabIndex={-1} aria-label="池内清单">
      <div className="pool-inventory-header">
        <h2>池内清单 <span>{filtered.length}</span></h2>
        <div className="pool-tools"><div className="pool-search"><IconSearch size={17} />
          <input aria-label="搜索池内股票" placeholder="名称或代码" maxLength={80} value={searchDraft ?? view.query}
            onCompositionStart={() => { composing.current = true; setSearchDraft(view.query); }}
            onCompositionEnd={event => { composing.current = false; setSearchDraft(null); update({ q: event.currentTarget.value || undefined }); }}
            onChange={event => { if (composing.current) setSearchDraft(event.target.value); else update({ q: event.target.value || undefined }); }} />
          {(searchDraft ?? view.query) && <button type="button" onClick={() => { composing.current = false; setSearchDraft(null); update({ q: undefined }); }} aria-label="清空股票搜索"><IconX size={14} /></button>}
        </div><button className="pool-refresh" type="button" onClick={refresh} aria-label="刷新股票池" disabled={busy}><IconRefresh size={18} className={busy ? "is-spinning" : ""} /></button></div>
      </div>
      {error && <div className="pool-error" role="alert">{error}<button type="button" onClick={refresh}>重试</button></div>}
      {!snapshot && !error && <div className="pool-list-empty" role="status">正在读取股票池…</div>}
      {snapshot && filtered.length === 0 && <div className="pool-list-empty">{view.query || view.state !== "all" ? "没有符合条件的股票" : "暂无订阅股票"}</div>}
      <div className="pool-list">{pageRows.map(entry => {
        const key = poolKey(entry), expanded = detail && selected === key;
        const detailId = `pool-row-${entry.market}-${encodeURIComponent(entry.code)}`;
        return <div className={`pool-list-item ${expanded ? "is-selected" : ""}`} key={key}>
          <button type="button" className="pool-row" onClick={() => choose(key)} aria-expanded={!!expanded} aria-controls={expanded ? detailId : undefined} title={entry.name || entry.code}>
            <div className="pool-row-stock"><StockIcon entry={entry} size={35} /><div><strong>{entry.name || entry.code}</strong><span>{entry.code} · {POOL_LABELS[entry.market]}</span></div></div>
            <span className={`pool-status is-${entry.state}`}><i />{POOL_STATES[entry.state]}</span>
            <div className="pool-row-expiry"><strong>{remaining(entry.expiresAt, snapshot!.at)}</strong><span>到期释放</span></div><IconChevronDown className="pool-row-arrow" size={15} />
          </button>
          {expanded && <div className="pool-row-detail" id={detailId}>
            <strong>{entry.name || entry.code}</strong>
            <dl><div><dt>最近请求</dt><dd>{timeText(entry.lastRequestedAt)}</dd></div><div><dt>释放时间</dt><dd>{timeText(entry.expiresAt)}</dd></div></dl>
            {entry.market !== "ASSET" && <button type="button" className="fire-cap" onClick={() => enter(entry)} aria-label={`查看 ${entry.name || entry.code} 详情`}>个股详情<IconArrowUpRight size={15} /></button>}
          </div>}
        </div>;
      })}</div>
      <footer className="pool-inventory-footer"><span>{snapshot ? `更新于 ${timeText(snapshot.at)}` : ""}</span>{totalPages > 1 && <div className="pool-pagination"><button type="button" disabled={page <= 1} onClick={() => update({ p: page > 2 ? String(page - 1) : undefined })} aria-label="上一页"><IconChevronLeft size={16} /></button><span>{page} / {totalPages}</span><button type="button" disabled={page >= totalPages} onClick={() => update({ p: String(page + 1) })} aria-label="下一页"><IconChevronRight size={16} /></button></div>}</footer>
    </section>
  </div>;
}
