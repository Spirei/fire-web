"use client";

import { useMemo, useState } from "react";
import { IconChevronDown, IconChevronRight, IconClock, IconDownload, IconRefresh, IconSearch, IconX } from "@tabler/icons-react";

export type AssistantTrace = {
  id:string; conversationId:string; serviceId:string; serviceName:string; model:string; status:string;
  latencyMs:number; promptTokens:number; completionTokens:number; estimatedCost:number; error:string;
  turnId:string; attemptIndex:number; firstTokenMs:number; imageCount:number;
  dataScope:"none"|"page"|"account"; createdAt:string;
};

const tone = {
  input: "bg-[#7898da]",
  model: "bg-[#987ac0]",
  tool: "bg-[#d98a2b]",
  error: "bg-[#dc5c68]",
};

function scopeLabel(scope: AssistantTrace["dataScope"]) {
  return scope === "account" ? "账户摘要" : scope === "page" ? "当前页面" : "不附带数据";
}

function shortTime(value:string) {
  return new Date(value).toLocaleString("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

export default function AssistantTraceView({ traces, query, onQueryChange, onRefresh }:{ traces:AssistantTrace[]; query:string; onQueryChange:(value:string)=>void; onRefresh:()=>void }) {
  const [selectedId,setSelectedId]=useState("");
  const [collapsedTurns,setCollapsedTurns]=useState<Set<string>>(new Set());
  const [detailsOpen,setDetailsOpen]=useState(false);
  const [detailTab,setDetailTab]=useState<"summary"|"payload"|"result"|"timing">("summary");
  const [realDuration,setRealDuration]=useState(false);
  const filtered=useMemo(()=>traces.filter(trace=>!query.trim()||`${trace.serviceName} ${trace.model} ${trace.status} ${trace.error}`.toLowerCase().includes(query.trim().toLowerCase())),[traces,query]);
  const groups=useMemo(()=>{
    const map=new Map<string,AssistantTrace[]>();
    for(const trace of filtered){const key=trace.turnId||trace.id;map.set(key,[...(map.get(key)||[]),trace]);}
    return [...map.entries()].map(([id,items])=>({id,items:items.sort((a,b)=>a.attemptIndex-b.attemptIndex)}));
  },[filtered]);
  const selected=traces.find(trace=>trace.id===selectedId)||null;
  const maxLatency=Math.max(1,...filtered.map(trace=>trace.latencyMs));
  const totalMs=filtered.reduce((sum,trace)=>sum+trace.latencyMs,0);
  const totalTokens=filtered.reduce((sum,trace)=>sum+trace.promptTokens+trace.completionTokens,0);
  const allCollapsed=groups.length>0&&groups.every(group=>collapsedTurns.has(group.id));
  const toggleAll=()=>setCollapsedTurns(allCollapsed?new Set():new Set(groups.map(group=>group.id)));
  const select=(trace:AssistantTrace)=>{setSelectedId(trace.id);setDetailTab("summary");setDetailsOpen(true);};
  const exportLog=()=>{
    const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),traces},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=`assistant-session-${Date.now()}.json`;link.click();URL.revokeObjectURL(url);
  };

  return <div className="-mx-5 -my-5 flex h-[calc(100%+2.5rem)] min-h-0 flex-col bg-white text-[#26282c] dark:bg-[#171819] dark:text-[#d8d9dc] sm:-mx-[12.5%] sm:-my-8 sm:h-[calc(100%+4rem)]">
    <div className="assistant-trace-toolbar flex h-11 shrink-0 items-center gap-1.5 border-b border-black/10 px-3 dark:border-white/10">
      <button type="button" onClick={()=>setRealDuration(value=>!value)} className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition ${realDuration?"bg-black/[.08] dark:bg-white/10":"text-[#70747c] hover:bg-black/[.045] dark:text-[#989ca4] dark:hover:bg-white/[.06]"}`}><IconClock size={14}/>时长</button>
      <button type="button" onClick={toggleAll} className="h-7 rounded-md px-2 text-xs text-[#70747c] hover:bg-black/[.045] dark:text-[#989ca4] dark:hover:bg-white/[.06]">{allCollapsed?"展开轮次":"收起轮次"}</button>
      <button type="button" onClick={()=>setDetailsOpen(false)} className="hidden h-7 rounded-md px-2 text-xs text-[#70747c] hover:bg-black/[.045] dark:text-[#989ca4] dark:hover:bg-white/[.06] sm:block">收起详情</button>
      <button type="button" onClick={onRefresh} className="flex h-7 w-7 items-center justify-center rounded-md text-[#70747c] hover:bg-black/[.045] dark:text-[#989ca4] dark:hover:bg-white/[.06]" aria-label="刷新运行记录"><IconRefresh size={14}/></button>
      <button type="button" onClick={exportLog} disabled={!traces.length} className="hidden h-7 items-center gap-1.5 rounded-md px-2 text-xs text-[#70747c] hover:bg-black/[.045] disabled:opacity-35 dark:text-[#989ca4] dark:hover:bg-white/[.06] md:flex"><span>Session log</span><IconDownload size={14}/></button>
      <label className="ml-auto flex h-7 w-48 items-center gap-1.5 rounded-md border border-black/10 bg-black/[.025] px-2 text-[#858991] dark:border-white/10 dark:bg-white/[.045]"><IconSearch size={14}/><input value={query} onChange={event=>onQueryChange(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-inherit outline-none" placeholder="搜索轨迹"/></label>
    </div>

    <div className="shrink-0 border-b border-black/10 bg-black/[.025] px-3 py-2 dark:border-white/10 dark:bg-white/[.025]">
      <div className="grid grid-cols-[42px_1fr] gap-x-2 gap-y-1 text-[10px] leading-none text-[#777b83] dark:text-[#858991]">
        <span>Input</span><div className="flex h-2 items-center gap-1">{groups.map(group=><span key={group.id} className={`${tone.input} h-2 min-w-3 rounded-[1px]`} style={{width:`${Math.max(12,100/groups.length)}%`}}/>)}</div>
        <span>Model</span><div className="flex h-2 items-center gap-1">{filtered.map(trace=><button key={trace.id} type="button" onClick={()=>select(trace)} className={`${trace.status==="ok"?tone.model:tone.error} h-2 min-w-3 rounded-[1px] opacity-90 hover:opacity-100`} style={{width:realDuration?`${Math.max(12,(trace.latencyMs/maxLatency)*72)}px`:"24px"}} aria-label={`${trace.model} ${trace.status}`}/>)}</div>
        <span>Tools</span><div className="flex h-2 items-center text-[9px] text-[#a0a3a8]">当前会话未产生工具调用</div>
      </div>
      <div className="mt-2 flex gap-4 text-[10px] text-[#737780] dark:text-[#8e929a]"><span>{groups.length} 轮</span><span>{filtered.length} 次模型调用</span><span>{totalMs} ms</span><span>{totalTokens.toLocaleString()} tok</span></div>
    </div>

    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto">
        {groups.length===0?<div className="flex h-full min-h-52 flex-col items-center justify-center text-sm text-[#8a8e95]"><span>当前对话还没有轨迹</span><span className="mt-1 text-xs opacity-70">发送问题后，这里会记录每一次模型尝试</span></div>:groups.map((group,groupIndex)=>{
          const collapsed=collapsedTurns.has(group.id); return <div key={group.id}>
            <button type="button" onClick={()=>setCollapsedTurns(current=>{const next=new Set(current);next.has(group.id)?next.delete(group.id):next.add(group.id);return next;})} className="grid w-full grid-cols-[128px_minmax(0,1fr)] border-b border-black/[.08] text-left text-xs hover:bg-black/[.025] dark:border-white/[.08] dark:hover:bg-white/[.025]">
              <span className="flex h-10 items-center gap-2 border-r border-black/[.08] px-3 font-medium dark:border-white/[.08]">{collapsed?<IconChevronRight size={14}/>:<IconChevronDown size={14}/>}轮次 {groupIndex+1}</span>
              <span className="flex h-10 items-center gap-3 px-3 text-[#777b83] dark:text-[#999da5]"><span className="rounded bg-[#7898da]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#5878ba] dark:text-[#9ab4ed]">INPUT</span>{group.items[0]?.imageCount?`${group.items[0].imageCount} 张图片 · `:""}{scopeLabel(group.items[0]?.dataScope||"none")}<span className="ml-auto">{shortTime(group.items[0]?.createdAt||"")}</span></span>
            </button>
            {!collapsed&&group.items.map(trace=><button key={trace.id} type="button" onClick={()=>select(trace)} className={`grid w-full grid-cols-[128px_minmax(0,1fr)] border-b border-black/[.07] text-left text-xs transition dark:border-white/[.07] ${selectedId===trace.id?"bg-black/[.055] dark:bg-white/[.07]":"hover:bg-black/[.025] dark:hover:bg-white/[.025]"}`}>
              <span className="flex h-11 items-center gap-2 border-r border-black/[.08] px-3 dark:border-white/[.08]"><span className={`h-2 w-2 rounded-full ${trace.status==="ok"?tone.model:tone.error}`}/><span className="rounded bg-[#987ac0]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#795b9f] dark:text-[#c2a4e6]">MODEL</span></span>
              <span className="flex min-w-0 h-11 items-center gap-3 px-3"><b className="truncate font-medium">{trace.serviceName}</b><span className="truncate text-[#777b83] dark:text-[#999da5]">{trace.model}</span><span className="ml-auto shrink-0 text-[#777b83] dark:text-[#999da5]">{trace.latencyMs} ms · {trace.promptTokens+trace.completionTokens} tok</span><IconChevronRight size={14} className="shrink-0 opacity-45"/></span>
            </button>)}
          </div>;
        })}
      </div>

      {detailsOpen&&selected&&<aside className="absolute inset-y-0 right-0 z-10 w-full overflow-y-auto border-l border-black/10 bg-[#f7f7f6] shadow-[-16px_0_40px_rgba(0,0,0,.08)] dark:border-white/10 dark:bg-[#202122] sm:w-[42%] sm:min-w-[360px]">
        <div className="sticky top-0 flex h-12 items-center border-b border-black/10 bg-[#f7f7f6]/95 px-4 backdrop-blur dark:border-white/10 dark:bg-[#202122]/95"><span className={`mr-2 h-2 w-2 rounded-full ${selected.status==="ok"?tone.model:tone.error}`}/><b className="text-xs tracking-wide">MODEL</b><span className="ml-3 text-xs text-[#777b83]">轮次 {Math.max(1,groups.findIndex(group=>group.items.some(item=>item.id===selected.id))+1)} · 调用 {selected.attemptIndex+1}</span><button type="button" onClick={()=>setDetailsOpen(false)} className="ml-auto flex h-7 w-7 items-center justify-center rounded-md hover:bg-black/[.06] dark:hover:bg-white/[.07]" aria-label="关闭详情"><IconX size={16}/></button></div>
        <div className="flex h-11 border-b border-black/10 px-4 dark:border-white/10">{(["summary","payload","result","timing"] as const).map(tab=><button key={tab} type="button" onClick={()=>setDetailTab(tab)} className={`relative mr-6 text-xs capitalize ${detailTab===tab?"text-[#315fbd] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#4d7edc] dark:text-[#78a4ff]":"text-[#777b83] dark:text-[#999da5]"}`}>{tab}</button>)}</div>
        <div className="p-5">
          {detailTab==="summary"&&<div><div className="grid grid-cols-[100px_1fr] gap-y-3 text-xs"><span className="text-[#858991]">Hierarchy</span><span>Assistant Message</span><span className="text-[#858991]">Status</span><span>{selected.status==="ok"?"Completed":selected.status==="empty"?"Empty response":"Failed"}</span><span className="text-[#858991]">Service</span><span>{selected.serviceName}</span><span className="text-[#858991]">Model</span><span className="break-all">{selected.model}</span></div></div>}
          {detailTab==="payload"&&<pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/[.04] p-3 text-[11px] leading-5 dark:bg-black/20">{JSON.stringify({dataScope:selected.dataScope,imageCount:selected.imageCount,attempt:selected.attemptIndex+1},null,2)}</pre>}
          {detailTab==="result"&&<div className="text-xs leading-5">{selected.error||"Model response completed successfully. Message content is not stored in the trace."}</div>}
          {detailTab==="timing"&&<div className="grid grid-cols-[100px_1fr] gap-y-3 text-xs"><span className="text-[#858991]">Started</span><span>{shortTime(selected.createdAt)}</span><span className="text-[#858991]">Duration</span><span>{selected.latencyMs} ms</span><span className="text-[#858991]">First token</span><span>{selected.firstTokenMs?`${selected.firstTokenMs} ms`:"—"}</span><span className="text-[#858991]">Tokens</span><span>{selected.promptTokens} in · {selected.completionTokens} out</span></div>}
        </div>
      </aside>}
    </div>
  </div>;
}
