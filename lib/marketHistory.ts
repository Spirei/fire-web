"use client";
import { clientRequestId } from "./randomId";
import { platformRequest } from "./platformRequest";
import { accountReadHeaders, privateReadEpoch } from "./privateReadContext";

interface HistoryPreparation { requestId:string; pending?:boolean; failed?:boolean; unavailable?:unknown[] }
const pause=(signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const stop=()=>{clearTimeout(timer);signal?.removeEventListener("abort",stop);reject(new DOMException("Aborted","AbortError"));};
  const timer=setTimeout(()=>{signal?.removeEventListener("abort",stop);resolve();},2000);
  if(signal?.aborted)stop();else signal?.addEventListener("abort",stop,{once:true});
});

/** Explicit view intent; all consumers use the same PG streams and Worker. */
export async function prepareMarketHistory(items: {market:string;code:string}[], options: {days?:number;adjust?:string;index?:boolean;minute?:boolean;ownerId?:string;signal?:AbortSignal} = {}) {
  const epoch=privateReadEpoch();
  const current=()=>{if(options.signal?.aborted || privateReadEpoch()!==epoch)throw new DOMException("Aborted","AbortError");};
  for(let source=0;source<4;source++) {
    let fallback=false;
    current();
    const requestId=clientRequestId();
    await platformRequest<HistoryPreparation>("/api/kline/prepare",{method:"POST",signal:options.signal,headers:{"Content-Type":"application/json",...accountReadHeaders(options.ownerId)},body:JSON.stringify({requestId,items,days:options.days ?? 330,adjust:options.adjust ?? "none",index:options.index === true,minute:options.minute === true})},20000);
    for(let attempt=0;attempt<60;attempt++) {
      current();
      const state=await platformRequest<HistoryPreparation>(`/api/kline/preparations/${encodeURIComponent(requestId)}`,{signal:options.signal,headers:accountReadHeaders(options.ownerId)},10000);
      current();
      if(state.requestId!==requestId || typeof state.pending!=="boolean" || typeof state.failed!=="boolean")throw new Error("历史采集进度格式无效");
      if(!state.pending){if(state.failed){fallback=true;break;}if(state.unavailable?.length)throw new Error("当前来源尚无此历史行情");return state;}
      await pause(options.signal);
    }
    current();
    if(!fallback)throw new Error("历史行情仍在采集，请稍后刷新");
  }
  throw new Error("历史行情采集尚未完成");
}
