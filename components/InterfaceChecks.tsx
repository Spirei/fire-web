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
  const [items,setItems]=useState<Check[]|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState<string|null>(null);
  const lifetime=useRef<AbortController|null>(null),lock=useRef(false),poll=useRef<ReturnType<typeof startVisiblePolling>|null>(null);
  const unresolved=useRef(new Map<string,string>());
  useEffect(()=>{setItems(null);setError("");unresolved.current.clear();},[ownerId]);
  async function read(signal:AbortSignal) {
    const value=await platformRequest<{items:Check[]}>("/api/fire/system/interface-checks",{signal});
    if(!signal.aborted){setItems(value.items);setError("");}
  }
  useEffect(()=>{
    if(!active)return;
    const c=lifetime.current=new AbortController();
    poll.current=startVisiblePolling({interval:()=>30000,read:async signal=>{
      if(lock.current)return;
      try{await read(signal);}catch(e){if(!signal.aborted)setError(e instanceof Error?e.message:"检测记录读取失败");}
    }});
    return()=>{c.abort();poll.current?.stop();poll.current=null;};
  },[active,ownerId]);
  async function test(item:Check) {
    if(lock.current||!lifetime.current||lifetime.current.signal.aborted)return;
    lock.current=true;setBusy(item.id);const signal=lifetime.current.signal;
    const pending=unresolved.current.get(item.id),id=pending||clientRequestId();
    unresolved.current.set(item.id,id);
    try{
      const result=await platformRequest<{state:string;message?:string;ok?:boolean}>(pending?`/api/fire/system/interface-checks/receipts/${id}`:"/api/futu/test",pending?{signal}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({requestId:id,sourceRevision:item.sourceRevision}),signal},20000);
      if(signal.aborted)return;
      if(result.state!=="unknown")unresolved.current.delete(item.id);
      showToast(result.message||"检测结果待核对",result.ok===true?"ok":"err");
      await read(signal);
    }catch(e){if(!signal.aborted){if(!pending&&e instanceof PlatformRequestError&&[400,401,403,409,422,429].includes(e.status||0))unresolved.current.delete(item.id);setError(e instanceof Error?e.message:"检测结果待核对");showToast(e instanceof Error?e.message:"检测结果待核对","err");}}
    finally{lock.current=false;if(!signal.aborted)setBusy(null);}
  }
  return <section className="interface-checks" aria-label="接口检测">
    <div className="system-section-heading"><div><h2>接口检测</h2></div><IconButton label="刷新检测记录" onClick={()=>void poll.current?.refresh()}><IconRefresh/></IconButton></div>
    {error&&<p className="system-error" role="alert">{error}</p>}
    <div className="interface-check-grid">{(items||[]).map(item=>{
      const last=item.points.at(-1);
      return <article key={item.id} className="interface-check-card" data-state={item.state} data-kind={item.kind} data-scope={item.scope}>
        <header><ServiceIcon kind={item.kind}/><h3>{item.label}</h3><span className="interface-check-tag">{item.scope==="connection"?"连接":"采集"}</span></header>
        <div className="interface-check-samples"><strong>{last?.elapsedMs!=null?`${Math.round(last.elapsedMs)} ms`:names[item.state]||"未知"}</strong><div className="interface-check-dots" aria-label="最近检测结果">{Array.from({length:12},(_,index)=>{const p=item.points[index-(12-item.points.length)];return <span key={index} data-state={p?.state||"empty"} title={p?`${new Date(p.at).toLocaleString("zh-CN")} · ${names[p.state]||"未知"}${p.elapsedMs!=null?` · ${Math.round(p.elapsedMs)} ms`:""}`:"尚无记录"}/>;})}</div></div>
        <p>{item.detail}</p><footer><small>{last?new Date(last.at).toLocaleString("zh-CN"):""}</small>{item.canTest?<Capsule size="sm" variant="secondary" busy={busy===item.id} disabled={busy!==null} onClick={()=>void test(item)}>{unresolved.current.has(item.id)?"核对结果":"检测"}</Capsule>:!item.configured?<Capsule size="sm" variant="ghost" onClick={()=>onSettings(item.kind)}>配置</Capsule>:null}</footer>
      </article>;
    })}{!items&&!error&&<p role="status" className="text-sm text-muted">正在读取检测记录…</p>}</div>
  </section>;
}
