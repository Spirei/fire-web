"use client";

import { useEffect, useRef, useState } from "react";
import { Capsule } from "./Capsule";
import { platformRequest, PlatformRequestError } from "@/lib/platformRequest";
import { clientRequestId } from "@/lib/randomId";

export const MARKET_SOURCE_ORDER = ["futu", "tencent", "eastmoney", "yahoo"];
const SOURCES: Record<string, { name: string; mark: string; detail: string }> = {
  futu: { name: "富途", mark: "F", detail: "OpenD 行情" },
  tencent: { name: "腾讯", mark: "Q", detail: "证券行情" },
  eastmoney: { name: "东方财富", mark: "E", detail: "证券与指数行情" },
  yahoo: { name: "Yahoo", mark: "Y", detail: "全球市场行情" }
};
type Result = { state: string; message?: string; price?: number; code?: string; market?: string; elapsedMs?: number; observedAt?: string; requestId?: string };
const label = (state?: string) => ({available:"报价可用",connected:"已连接",unavailable:"暂不可用",unconfigured:"未配置",unknown:"待核对",testing:"检测中…"}[state ?? ""] || "未检测");
const orderOf = (order?: string[]) => order?.length === 4 && new Set(order).size === 4 && order.every(key => SOURCES[key]) ? order : MARKET_SOURCE_ORDER;

export default function MarketSourceSettings({ order, onSave, enabled = true }: { order?: string[]; enabled?: boolean; onSave: (order: string[]) => Promise<boolean> }) {
  const [items, setItems] = useState(() => orderOf(order));
  const [results, setResults] = useState<Record<string, Result>>({});
  const [saving, setSaving] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const busy = useRef(new Set<string>()), mounted = useRef(true), savePending = useRef(false);
  const pending = useRef<Record<string,string>>({});
  const generations = useRef<Record<string,number>>({});
  useEffect(() => { if (!savePending.current) setItems(orderOf(order)); }, [order]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | undefined;
    const load = () => {
      controller?.abort(); controller = new AbortController();
      const active = controller, before = {...generations.current};
      void platformRequest<{results:Record<string,Result>}>("/api/fire/market-sources/tests", {signal:active.signal}).then(data => {
        if (active.signal.aborted || !mounted.current) return;
        setResults(current => {
          const next = {...current};
          for (const [key,value] of Object.entries(data.results)) {
            if (before[key] !== generations.current[key] || busy.current.has(key)) continue;
            next[key] = value;
            if (value.state === "unknown" && value.requestId) pending.current[key] = value.requestId;
            else delete pending.current[key];
          }
          return next;
        });
      }).catch(() => {});
    };
    load(); window.addEventListener("fire:settings-updated",load);
    return () => { controller?.abort(); window.removeEventListener("fire:settings-updated",load); };
  }, [enabled]);

  async function move(key: string, to: number) {
    if (savePending.current || to < 0 || to >= items.length) return;
    const previous = items, next = items.filter(value => value !== key);
    next.splice(to, 0, key);
    setDragged(null); setOver(null);
    if (next.join() === previous.join()) return;
    savePending.current = true; setSaving(true); setItems(next);
    try { if (!await onSave(next) && mounted.current) setItems(previous); }
    catch { if (mounted.current) setItems(previous); }
    finally { savePending.current = false; if (mounted.current) setSaving(false); }
  }

  async function test(key: string) {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    generations.current[key] = (generations.current[key] ?? 0) + 1;
    const requestId = pending.current[key] ??= clientRequestId();
    setResults(current => ({...current,[key]:{...current[key],state:"testing"}}));
    try {
      const result = await platformRequest<Result>("/api/fire/market-sources/tests", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:key,requestId})},25000);
      if (result.requestId !== requestId) throw Error("检测结果尚未确认");
      if (result.state !== "unknown") delete pending.current[key];
      if (mounted.current) setResults(current => ({...current,[key]:result}));
    } catch (error) {
      if (error instanceof PlatformRequestError && [400,401,403,409,422,429].includes(error.status ?? 0)) {
        delete pending.current[key];
        if (mounted.current) setResults(current => ({...current,[key]:{state:"unavailable",message:error.message}}));
        return;
      }
      // An interrupted request is receipt-only; never start another external probe.
      if (mounted.current) setResults(current => ({...current,[key]:{state:"unknown",requestId,message:"检测结果尚未确认"}}));
    } finally { busy.current.delete(key); }
  }
  async function testAll() {
    let cursor = 0;
    const run = async () => { while (cursor < items.length) await test(items[cursor++]); };
    await Promise.all([run(),run()]);
  }
  return <div className="market-source-settings">
    <div className="market-source-toolbar"><span>{saving ? "正在保存顺序…" : "按顺序选择可用来源"}</span><Capsule size="sm" variant="secondary" type="button" disabled={Object.values(results).some(result => result.state === "testing")} onClick={() => void testAll()}>检测全部</Capsule></div>
    <ol className="market-source-list" aria-label="行情源优先顺序" aria-busy={saving}>
      {items.map((key,index) => {
        const source = SOURCES[key], result = results[key];
        return <li key={key} className={`market-source-row ${over === key && dragged !== key ? "is-drop-target" : ""} ${dragged === key ? "is-dragging" : ""}`} onDragOver={event => { if (!dragged || saving) return; event.preventDefault(); event.dataTransfer.dropEffect="move"; setOver(key); }} onDrop={event => { event.preventDefault(); if (dragged) void move(dragged,index); }}>
          <button type="button" className="market-source-grip" draggable={!saving} disabled={saving} aria-label={`拖动${source.name}排序`} onDragStart={event => { event.dataTransfer.setData("text/plain",key); event.dataTransfer.effectAllowed="move"; setDragged(key); }} onDragEnd={() => { setDragged(null); setOver(null); }}><svg viewBox="0 0 12 20" width="10" height="18" fill="currentColor" aria-hidden="true">{[5,10,15].flatMap(y => [3,9].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2"/>))}</svg></button>
          <span className={`market-source-mark provider-${key}`} aria-hidden="true">{source.mark}</span>
          <div className="market-source-copy"><div><strong>{source.name}</strong><span className="market-source-rank">{index === 0 ? "优先" : `备用 ${index}`}</span></div><small>{result?.price != null ? `${result.code} ${result.market === "US" ? "$" : result.market === "HK" ? "HK$" : "¥"}${result.price.toLocaleString("en-US",{maximumFractionDigits:4})}` : result?.message || source.detail}</small></div>
          <div className="market-source-health" title={[result?.message,result?.observedAt && new Date(result.observedAt).toLocaleString("zh-CN",{hour12:false})].filter(Boolean).join(" · ")}><span data-state={result?.state ?? "untested"}><i/>{label(result?.state)}</span>{result?.elapsedMs != null && <small>{result.elapsedMs < 1000 ? `${result.elapsedMs} ms` : `${(result.elapsedMs/1000).toFixed(2)} s`}</small>}</div>
          <div className="market-source-actions"><Capsule size="sm" variant="secondary" type="button" disabled={result?.state === "testing"} onClick={() => void test(key)}>{result?.state === "unknown" ? "核对" : "检测"}</Capsule><div className="market-source-moves"><button type="button" aria-label={`${source.name}上移`} disabled={saving || index === 0} onClick={() => void move(key,index-1)}>↑</button><button type="button" aria-label={`${source.name}下移`} disabled={saving || index === items.length-1} onClick={() => void move(key,index+1)}>↓</button></div></div>
        </li>;
      })}
    </ol>
  </div>;
}
