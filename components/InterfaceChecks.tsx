"use client";
import { useEffect, useRef, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import ServiceIcon from "./ServiceIcon";
import { IconButton, Capsule } from "./Capsule";
import { platformRequest, PlatformRequestError } from "@/lib/platformRequest";
import { clientRequestId } from "@/lib/randomId";
import { showToast } from "@/lib/toast";
import { startVisiblePolling } from "@/lib/visiblePolling";

type Point = {state:string;at:string;elapsedMs:number|null};
type Check = {id:string;label:string;kind:string;state:string;detail:string;configured:boolean;canTest:boolean;sourceRevision?:string;points:Point[];scope:string};
const names:Record<string,string> = {up:"正常",down:"异常",warning:"部分可用",unknown:"未检测",unconfigured:"未配置"};

export default function InterfaceChecks({active,ownerId,onSettings}:{active:boolean;ownerId:string;onSettings:(kind:string)=>void}) {
  const [snapshot,setSnapshot]=useState<{ownerId:string;items:Check[]}|null>(null);
  const [failure,setFailure]=useState<{ownerId:string;message:string}|null>(null);
  const [busy,setBusy]=useState<string|null>(null),[refreshing,setRefreshing]=useState(false);
  const lifetime=useRef<AbortController|null>(null),lock=useRef<AbortController|null>(null);
  const poll=useRef<ReturnType<typeof startVisiblePolling>|null>(null);
  const unresolved=useRef(new Map<string,string>());
  // Retained workspaces must never expose another account's previous projection.
  const items=snapshot?.ownerId === ownerId ? snapshot.items : null;
  const error=failure?.ownerId === ownerId ? failure.message : "";
  const reportError=(message:string)=>setFailure({ownerId,message});

  useEffect(()=>{unresolved.current.clear();},[ownerId]);
  async function read(signal:AbortSignal) {
    const value=await platformRequest<{items:Check[]}>("/api/fire/system/interface-checks",{signal});
    if(!signal.aborted){setSnapshot({ownerId,items:value.items});setFailure(null);}
  }
  useEffect(()=>{
    setBusy(null);setRefreshing(false);
    if(!active)return;
    const controller=new AbortController();
    lifetime.current=controller;
    const polling=startVisiblePolling({interval:()=>30000,read:async signal=>{
      if(lock.current)return;
      try{await read(signal);}catch(e){if(!signal.aborted)reportError(e instanceof Error?e.message:"检测记录读取失败");}
    }});
    poll.current=polling;
    return()=>{
      controller.abort();polling.stop();
      if(lifetime.current===controller)lifetime.current=null;
      if(lock.current===controller)lock.current=null;
      if(poll.current===polling)poll.current=null;
    };
  },[active,ownerId]);

  async function refresh() {
    const controller=lifetime.current;
    if(!controller||controller.signal.aborted||lock.current||refreshing)return;
    setRefreshing(true);
    try{await poll.current?.refresh();}
    finally{if(lifetime.current===controller)setRefreshing(false);}
  }
  async function test(item:Check) {
    const controller=lifetime.current;
    if(lock.current||!controller||controller.signal.aborted)return;
    lock.current=controller;setBusy(item.id);
    const signal=controller.signal,pending=unresolved.current.get(item.id),id=pending||clientRequestId();
    unresolved.current.set(item.id,id);
    try{
      const result=await platformRequest<{state:string;message?:string;ok?:boolean;observationRecorded?:boolean;observedAt?:string}>(pending?`/api/fire/system/interface-checks/receipts/${id}`:"/api/futu/test",pending?{signal}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:id,sourceRevision:item.sourceRevision}),signal},40000);
      if(signal.aborted)return;
      if(result.state!=="unknown"||result.observationRecorded===true||typeof result.observedAt==="string"&&Number.isFinite(Date.parse(result.observedAt)))unresolved.current.delete(item.id);
      showToast(result.message||"检测结果待核对",result.ok===true?"ok":"err");
      await read(signal);
    }catch(e){
      if(!signal.aborted){
        if(!pending&&e instanceof PlatformRequestError&&[400,401,403,409,422,429].includes(e.status||0))unresolved.current.delete(item.id);
        const message=e instanceof Error?e.message:"检测结果待核对";
        reportError(message);showToast(message,"err");
      }
    }finally{
      // An aborted operation from a hidden workspace cannot unlock its replacement.
      if(lock.current===controller){lock.current=null;setBusy(null);}
    }
  }
  return <section className="interface-checks" aria-label="接口检测">
    <div className="system-section-heading"><h2>接口检测</h2><IconButton label="刷新检测记录" busy={refreshing} disabled={busy!==null} onClick={()=>void refresh()}><IconRefresh/></IconButton></div>
    {error&&<p className="system-error" role="alert">{error}</p>}
    <div className="interface-check-grid" aria-busy={!items&&!error || refreshing}>{(items||[]).map(item=>{
      const points=item.points.slice(-12),last=points.at(-1);
      return <article key={item.id} className="interface-check-card" data-state={item.state} data-kind={item.kind} data-scope={item.scope} data-checking={busy===item.id||refreshing||undefined} data-active={active||undefined}>
        <header><ServiceIcon kind={item.kind}/><h3>{item.label}</h3><span className="interface-check-tag">{item.scope==="connection"?"连接":"采集"}</span></header>
        <div className="interface-check-samples"><strong>{last?.elapsedMs!=null?`${Math.round(last.elapsedMs)} ms`:names[item.state]||"未知"}</strong><div className="interface-check-dots" aria-label="最近检测结果">{Array.from({length:12},(_,index)=>{const point=points[index-(12-points.length)];return <span key={`${index}:${point?.at||"empty"}`} data-latest={index===11&&!!point||undefined} data-state={point?.state||"empty"} title={point?`${new Date(point.at).toLocaleString("zh-CN")} · ${names[point.state]||"未知"}${point.elapsedMs!=null?` · ${Math.round(point.elapsedMs)} ms`:""}`:"尚无记录"}/>;})}</div></div>
        <p>{item.detail}</p><footer><small>{last?new Date(last.at).toLocaleString("zh-CN"):""}</small>{item.canTest?<Capsule size="sm" variant="secondary" busy={busy===item.id} disabled={busy!==null||refreshing} onClick={()=>void test(item)}>{unresolved.current.has(item.id)?"核对结果":"检测"}</Capsule>:!item.configured?<Capsule size="sm" variant="ghost" onClick={()=>onSettings(item.kind)}>配置</Capsule>:null}</footer>
      </article>;
    })}{!items&&!error&&<p role="status" className="interface-check-loading text-sm text-muted">正在读取检测记录…</p>}</div>
  </section>;
}
