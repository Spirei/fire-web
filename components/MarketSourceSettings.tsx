"use client";

import { useEffect, useRef, useState } from "react";
import { Capsule } from "./Capsule";
import { platformRequest, PlatformRequestError } from "@/lib/platformRequest";
import { clientRequestId } from "@/lib/randomId";
import { accountReadHeaders } from "@/lib/privateReadContext";

export const MARKET_SOURCE_ORDER = ["futu", "tencent", "eastmoney", "yahoo"];
const SOURCES: Record<string, { name: string; mark: string; detail: string }> = {
  futu: { name: "富途", mark: "F", detail: "OpenD 行情" },
  tencent: { name: "腾讯", mark: "Q", detail: "证券行情" },
  eastmoney: { name: "东方财富", mark: "E", detail: "证券与指数行情" },
  yahoo: { name: "Yahoo", mark: "Y", detail: "全球市场行情" }
};
type MarketResult = { state:string; code?:string; price?:number; message?:string; sourceTime?:string; observedAt?:string };
type Result = MarketResult & { market?: string; elapsedMs?: number; requestId?: string; markets?:Record<string,MarketResult> };
const MARKETS:Record<string,string>={US:"美股",HK:"港股",CN:"A股",JP:"日股",KR:"韩股"};
const label = (state?: string) => ({available:"报价可用",partial:"部分可用",connected:"已连接",unavailable:"暂不可用",unconfigured:"未配置",unknown:"待核对",testing:"检测中…"}[state ?? ""] || "未检测");
const priceKnown = (price:unknown):price is number => typeof price === "number" && Number.isFinite(price) && price > 0;
const orderOf = (order?: string[]) => order?.length === 4 && new Set(order).size === 4 && order.every(key => SOURCES[key]) ? order : MARKET_SOURCE_ORDER;

export default function MarketSourceSettings({ order, onSave, enabled = true, ownerId = "" }: { order?: string[]; enabled?: boolean; ownerId?:string; onSave: (order: string[]) => Promise<boolean> }) {
  const [items, setItems] = useState(() => orderOf(order));
  const [results, setResults] = useState<Record<string, Result>>({});
  const [saving, setSaving] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const busy = useRef(new Map<string,AbortController>()), mounted = useRef(true), savePending = useRef(false);
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  const context = useRef(0), [loaded,setLoaded]=useState(false), [readError,setReadError]=useState(""), [readVersion,setReadVersion]=useState(0);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const pending = useRef<Record<string,string>>({});
  const generations = useRef<Record<string,number>>({});
  useEffect(() => { if (!savePending.current) setItems(orderOf(order)); }, [order]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    context.current++; busy.current.forEach(controller=>controller.abort()); busy.current.clear();
    pending.current={}; generations.current={}; setResults({}); setLoaded(false); setReadError("");
    return ()=>{context.current++;busy.current.forEach(controller=>controller.abort());busy.current.clear();};
  },[ownerId]);
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | undefined;
    const load = (event?:Event) => {
      if (event && (event as CustomEvent).detail?.dataChanged===false) return;
      if (event) {
        context.current++; busy.current.forEach(value=>value.abort()); busy.current.clear();
        pending.current={};setResults({});
      }
      setLoaded(false); setReadError("");
      controller?.abort(); controller = new AbortController();
      const active = controller, before = {...generations.current}, version=context.current;
      void platformRequest<{results:Record<string,Result>}>("/api/fire/market-sources/tests", {signal:active.signal,headers:accountReadHeaders(ownerId)}).then(data => {
        if (active.signal.aborted || !mounted.current || context.current!==version || ownerRef.current!==ownerId) return;
        if (!data?.results || typeof data.results!=="object" || Array.isArray(data.results)) throw Error("检测记录格式无效");
        setLoaded(true);
        setResults(current => {
          const next = {...current};
          for (const [key,value] of Object.entries(data.results)) {
            if (!SOURCES[key] || !value || typeof value.state!=="string") continue;
            if (before[key] !== generations.current[key] || busy.current.has(key)) continue;
            next[key] = value;
            if (value.state === "unknown" && value.requestId) pending.current[key] = value.requestId;
            else delete pending.current[key];
          }
          return next;
        });
      }).catch(() => {if(!active.signal.aborted && mounted.current && context.current===version && ownerRef.current===ownerId)setReadError("暂时无法读取检测记录");});
    };
    load(); window.addEventListener("fire:settings-updated",load);
    return () => { controller?.abort(); window.removeEventListener("fire:settings-updated",load); };
  }, [enabled,ownerId,readVersion]);

  async function move(key: string, to: number) {
    if (!enabledRef.current || savePending.current || to < 0 || to >= items.length) return;
    const currentOwner=ownerId, version=context.current;
    const previous = items, next = items.filter(value => value !== key);
    next.splice(to, 0, key);
    setDragged(null); setOver(null);
    if (next.join() === previous.join()) return;
    savePending.current = true; setSaving(true); setItems(next);
    try { if (!await onSave(next) && mounted.current && ownerRef.current===currentOwner && context.current===version) setItems(previous); }
    catch { if (mounted.current && ownerRef.current===currentOwner && context.current===version) setItems(previous); }
    finally { savePending.current = false; if (mounted.current) setSaving(false); }
  }

  async function test(key: string) {
    if (!mounted.current || !enabledRef.current || ownerRef.current!==ownerId || !loaded || busy.current.has(key)) return;
    const controller=new AbortController(), version=context.current, currentOwner=ownerId;
    busy.current.set(key,controller);
    const current=()=>mounted.current && context.current===version && ownerRef.current===currentOwner && busy.current.get(key)===controller;
    generations.current[key] = (generations.current[key] ?? 0) + 1;
    const requestId = pending.current[key] ??= clientRequestId();
    setResults(current => ({...current,[key]:{...current[key],state:"testing"}}));
    try {
      const result = await platformRequest<Result>("/api/fire/market-sources/tests", {method:"POST",signal:controller.signal,headers:{"Content-Type":"application/json",...accountReadHeaders(currentOwner)},body:JSON.stringify({provider:key,requestId})},25000);
      if (!current()) return;
      if (result.requestId !== requestId) throw Error("检测结果尚未确认");
      if (result.state !== "unknown") delete pending.current[key];
      setResults(current => ({...current,[key]:result}));
    } catch (error) {
      if (!current()) return;
      if (error instanceof PlatformRequestError && [400,401,403,409,422,429].includes(error.status ?? 0)) {
        delete pending.current[key];
        if (mounted.current) setResults(current => ({...current,[key]:{state:"unavailable",message:error.message}}));
        return;
      }
      // An interrupted request is receipt-only; never start another external probe.
      if (mounted.current) setResults(current => ({...current,[key]:{state:"unknown",requestId,message:"检测结果尚未确认"}}));
    } finally { if(busy.current.get(key)===controller)busy.current.delete(key); }
  }
  async function testAll() {
    let cursor = 0; const version=context.current, currentOwner=ownerId;
    const run = async () => { while (mounted.current && enabledRef.current && context.current===version && ownerRef.current===currentOwner && cursor < items.length) await test(items[cursor++]); };
    await Promise.all([run(),run()]);
  }
  return <div className="market-source-settings">
    <div className="market-source-toolbar"><span role="status">{saving ? "正在保存顺序…" : readError || (!loaded && enabled ? "正在读取上次检测…" : "自动模式按顺序选择可用来源")}</span><div className="market-source-toolbar-actions">{readError && <Capsule size="sm" variant="secondary" type="button" onClick={()=>setReadVersion(value=>value+1)}>重新读取</Capsule>}<Capsule size="sm" variant="secondary" type="button" disabled={!enabled || !loaded || Object.values(results).some(result => result.state === "testing")} onClick={() => void testAll()}>检测全部</Capsule></div></div>
    <ol className="market-source-list" aria-label="行情源优先顺序" aria-busy={saving}>
      {items.map((key,index) => {
        const source = SOURCES[key], result = results[key];
        return <li key={key} className={`market-source-row ${over === key && dragged !== key ? "is-drop-target" : ""} ${dragged === key ? "is-dragging" : ""}`} onDragOver={event => { if (!dragged || saving) return; event.preventDefault(); event.dataTransfer.dropEffect="move"; setOver(key); }} onDrop={event => { event.preventDefault(); if (dragged) void move(dragged,index); }}>
          <button type="button" className="market-source-grip" draggable={enabled && !saving} disabled={!enabled || saving} aria-label={`拖动${source.name}排序`} onDragStart={event => { event.dataTransfer.setData("text/plain",key); event.dataTransfer.effectAllowed="move"; setDragged(key); }} onDragEnd={() => { setDragged(null); setOver(null); }}><svg viewBox="0 0 12 20" width="10" height="18" fill="currentColor" aria-hidden="true">{[5,10,15].flatMap(y => [3,9].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2"/>))}</svg></button>
          <span className={`market-source-mark provider-${key}`} aria-hidden="true">{source.mark}</span>
          <div className="market-source-copy"><div><strong>{source.name}</strong><span className="market-source-rank">{index === 0 ? "优先" : `备用 ${index}`}</span></div><small>{priceKnown(result?.price) ? `${result?.code} ${result?.market === "US" ? "$" : result?.market === "HK" ? "HK$" : result?.market === "KR" ? "₩" : "¥"}${result.price.toLocaleString("en-US",{maximumFractionDigits:4})}` : result?.message || source.detail}</small>{result?.markets && <div className="market-source-markets" aria-label={`${source.name}分市场检测`}>{Object.entries(result.markets).filter(([market])=>MARKETS[market]).map(([market,value])=><span key={market} data-state={value.state} title={[value.code,priceKnown(value.price)?String(value.price):value.message,value.sourceTime || value.observedAt].filter(Boolean).join(" · ")}>{MARKETS[market]} <i/>{value.state==="available"?"可用":value.state==="unavailable"?"无报价":"待核对"}</span>)}</div>}</div>
          <div className="market-source-health" title={[result?.message,result?.observedAt && new Date(result.observedAt).toLocaleString("zh-CN",{hour12:false})].filter(Boolean).join(" · ")}><span data-state={result?.state ?? "untested"}><i/>{label(result?.state)}</span>{result?.elapsedMs != null && <small>{result.elapsedMs < 1000 ? `${result.elapsedMs} ms` : `${(result.elapsedMs/1000).toFixed(2)} s`}</small>}</div>
          <div className="market-source-actions"><Capsule size="sm" variant="secondary" type="button" disabled={!enabled || !loaded || result?.state === "testing"} onClick={() => void test(key)}>{result?.state === "unknown" ? "核对" : "检测"}</Capsule><div className="market-source-moves"><button type="button" aria-label={`${source.name}上移`} disabled={!enabled || saving || index === 0} onClick={() => void move(key,index-1)}>↑</button><button type="button" aria-label={`${source.name}下移`} disabled={!enabled || saving || index === items.length-1} onClick={() => void move(key,index+1)}>↓</button></div></div>
        </li>;
      })}
    </ol>
  </div>;
}
