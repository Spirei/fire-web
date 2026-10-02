"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { IconBoltFilled, IconCheck, IconClock, IconDeviceDesktop, IconFingerprint, IconList, IconPencil, IconShieldCheck, IconUpload, IconUserCircle } from "@tabler/icons-react";
import { copyText } from "@/lib/clipboard";
import AppModal from "./AppModal";
import SafeAssetImage from "./SafeAssetImage";
import { feedRequest, FeedRequestError, feedJobRunning } from "@/lib/feedClient";
import type { FeedAgentProfile, FeedJob, FeedJobPage, FeedPayload } from "@/lib/feedTypes";

const DEFAULT_IMAGE="/uploads/feature/feed/alcor.png";
const TABS=[{id:"activity",label:"更新记录",icon:IconList},{id:"sources",label:"关注来源",icon:IconShieldCheck},{id:"services",label:"运行状态",icon:IconDeviceDesktop},{id:"schedule",label:"更新计划",icon:IconClock},{id:"identity",label:"名称与形象",icon:IconFingerprint}] as const;
export type FeedAgentTab=typeof TABS[number]["id"];
export const validFeedAgentTab=(value:string|null):FeedAgentTab=>TABS.find(t=>t.id===value)?.id||"activity";
const STATUS={queued:"等待更新",searching:"搜集动态来源",writing:"整理动态内容",done:"完成动态更新",error:"动态更新未完成"};
function day(value:string) {return new Date(value).toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long",timeZone:"Asia/Shanghai"});}
function time(value:string) {return new Date(value).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Shanghai"});}
function dateKey(value:string) {return new Date(value).toLocaleDateString("en-CA",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"Asia/Shanghai"});}
function description(job:FeedJob) {return job.error||(job.status==="done"?job.added?`新增 ${job.added} 条动态`:"暂无新动态":job.status==="queued"?"已加入更新队列":job.status==="searching"?"正在读取来源":"正在整理内容");}

export default function FeedAgentPanel({data,tab,onTabChange,onClose,onProfileChange,onRefresh,refreshDisabled}:{data:FeedPayload;tab:FeedAgentTab;onTabChange:(tab:FeedAgentTab)=>void;onClose:()=>void;onProfileChange:(profile:FeedAgentProfile)=>void;onRefresh:()=>void;refreshDisabled:boolean}) {
  const profile=data.agent||{name:"Alcor",image:null,revision:0,updatedAt:null};
  const [menu,setMenu]=useState(false),[editing,setEditing]=useState<"name"|"avatar"|null>(null),[name,setName]=useState(profile.name),[editRevision,setEditRevision]=useState(profile.revision);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[needsRead,setNeedsRead]=useState(false),[copied,setCopied]=useState(false);
  const [history,setHistory]=useState<FeedJobPage|null>(null),[historyLoading,setHistoryLoading]=useState(false),[historyError,setHistoryError]=useState(""),[historyRead,setHistoryRead]=useState(0);
  const live=useRef(true),lock=useRef(false),menuRef=useRef<HTMLDivElement>(null),pencilRef=useRef<HTMLButtonElement>(null),fileRef=useRef<HTMLInputElement>(null),historyController=useRef<AbortController|null>(null),historyEpoch=useRef(0);
  const group=data.group?.id||"default";
  useEffect(()=>{live.current=true;return()=>{live.current=false;historyController.current?.abort();};},[]);
  useEffect(()=>{
    if(!menu)return;
    const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node)&&!pencilRef.current?.contains(event.target as Node))setMenu(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.stopImmediatePropagation();setMenu(false);pencilRef.current?.focus();}};
    document.addEventListener("pointerdown",outside);document.addEventListener("keydown",escape,true);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return()=>{document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape,true);};
  },[menu]);
  useEffect(()=>{setCopied(false);},[tab,group]);
  useEffect(()=>{if(!editing)setName(profile.name);},[profile.name,editing]);
  useEffect(()=>{
    if(tab!=="activity")return;
    const epoch=++historyEpoch.current,controller=new AbortController();historyController.current=controller;
    setHistoryLoading(true);setHistoryError("");
    void feedRequest<FeedJobPage>(`/jobs?group=${encodeURIComponent(group)}`,"GET",undefined,controller.signal).then(value=>{if(live.current&&epoch===historyEpoch.current)setHistory(old=>{if(!old)return value;const byId=new Map(old.jobs.map(job=>[job.id,job]));value.jobs.forEach(job=>byId.set(job.id,job));return {jobs:[...byId.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)),nextCursor:old.jobs.length>=30?old.nextCursor:value.nextCursor};});}).catch(e=>{if(!controller.signal.aborted&&live.current)setHistoryError(e.message);}).finally(()=>{if(!controller.signal.aborted&&live.current)setHistoryLoading(false);});
    return()=>{++historyEpoch.current;historyController.current?.abort();};
  },[tab,group,data.job?.updatedAt,historyRead]);
  async function older() {
    if(!history?.nextCursor||historyLoading)return;
    const epoch=historyEpoch.current,controller=new AbortController();historyController.current=controller;setHistoryLoading(true);setHistoryError("");
    try {const page=await feedRequest<FeedJobPage>(`/jobs?group=${encodeURIComponent(group)}&cursor=${encodeURIComponent(history.nextCursor)}`,"GET",undefined,controller.signal);if(live.current&&epoch===historyEpoch.current)setHistory(old=>({jobs:[...(old?.jobs||[]),...page.jobs.filter(job=>!old?.jobs.some(prev=>prev.id===job.id))],nextCursor:page.nextCursor}));}
    catch(e){if(!controller.signal.aborted&&live.current)setHistoryError(e instanceof Error?e.message:"读取失败");}
    finally{if(!controller.signal.aborted&&live.current)setHistoryLoading(false);}
  }
  function edit(which:"name"|"avatar") {setMenu(false);if(!needsRead)setError("");setEditing(which);setName(profile.name);setEditRevision(profile.revision);}
  async function reread() {
    if(lock.current)return;lock.current=true;setBusy(true);setError("");
    try{const value=await feedRequest<FeedAgentProfile>("/profile");if(live.current){onProfileChange(value);setEditRevision(value.revision);if(editing!=="name")setName(value.name);setNeedsRead(false);}}
    catch(e){if(live.current)setError(e instanceof Error?e.message:"读取失败");}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function save(body:unknown,upload=false) {
    if(lock.current||needsRead)return;lock.current=true;setBusy(true);setError("");
    try {
      const next=await feedRequest<FeedAgentProfile>(upload?"/profile/avatar":"/profile",upload?"POST":"PUT",body);
      if(live.current){onProfileChange(next);setEditing(null);}
    }catch(e){if(live.current){setError(e instanceof Error?e.message:"保存失败");if(e instanceof FeedRequestError&&(e.unconfirmed||e.status===409))setNeedsRead(true);}}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function upload(file:File|undefined) {
    if(!file)return;
    if(file.size>2*1024*1024){setError("图片最大 2 MB");return;}
    const form=new FormData();form.set("file",file);form.set("revision",String(editRevision));await save(form,true);
  }
  async function share() {
    try{const url=new URL(location.href);url.searchParams.set("feedAgent","profile");url.searchParams.set("feedAgentTab",tab);if(!await copyText(url.href))throw new Error("copy failed");if(live.current)setCopied(true);}
    catch{if(live.current)setError("链接复制失败");}
  }
  const jobs=history?.jobs|| (data.job?[data.job]:[]);
  const sourceErrors=data.peopleSources?.filter(source=>source.error)||[];
  return <AppModal title={`${profile.name} 的动态`} size="md" className="feed-theme feed-themed-modal feed-agent-modal" onClose={onClose} closeDisabled={busy} headerActions={<button type="button" className="feed-agent-round" disabled={busy} aria-label={copied?"链接已复制":"复制动态链接"} onClick={()=>void share()}>{copied?<IconCheck size={24}/>:<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3m-4 4 4-4 4 4M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/></svg>}</button>}>
    <div className="feed-agent-hero">
      <div className="feed-agent-portrait"><SafeAssetImage src={profile.image||DEFAULT_IMAGE} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} alt={profile.name} fallback={<IconUserCircle size={88} stroke={1}/>}/>
        <button ref={pencilRef} type="button" className="feed-agent-round feed-agent-pencil" aria-label="编辑小人" aria-expanded={menu} aria-controls="feed-agent-edit-menu" disabled={busy} onClick={()=>setMenu(v=>!v)}><IconPencil size={23} stroke={1.7}/></button>
        {menu&&<div id="feed-agent-edit-menu" ref={menuRef} className="feed-agent-edit-menu" aria-label="编辑小人选项"><button type="button" onClick={()=>edit("avatar")}><IconUserCircle size={27} stroke={1.7}/>更换虚拟形象</button><button type="button" onClick={()=>edit("name")}><IconPencil size={27} stroke={1.7}/>编辑名称</button></div>}
      </div>
      <h2>{profile.name}</h2><div className="feed-agent-connected"><span><IconBoltFilled size={13}/></span>已连接</div>
    </div>
    <nav className="feed-agent-tabs" aria-label="小人详情">{TABS.map(item=><button type="button" key={item.id} disabled={busy} aria-label={item.label} title={item.label} aria-pressed={tab===item.id} onClick={()=>{onTabChange(item.id);setEditing(null);setMenu(false);}}><item.icon size={26} stroke={1.7}/></button>)}</nav>
    {error&&<p className="feed-error" role="alert">{error}{needsRead&&<button type="button" disabled={busy} onClick={()=>void reread()}>重新读取</button>}</p>}
    {editing&&<div className="feed-agent-editor">
      {editing==="name"?<form onSubmit={e=>{e.preventDefault();void save({name:name.trim(),revision:editRevision});}}><label htmlFor="feed-agent-name">名称</label><input id="feed-agent-name" value={name} onChange={e=>setName(e.target.value)} maxLength={40} autoFocus disabled={busy}/><div className="feed-agent-editor-actions"><button type="button" className="feed-secondary" disabled={busy} onClick={()=>setEditing(null)}>取消</button><button type="submit" className="feed-primary" disabled={busy||needsRead||!name.trim()}>{busy?"保存中…":"保存"}</button></div></form>:<><h3>更换虚拟形象</h3><div className="feed-agent-avatar-options"><button type="button" disabled={busy||needsRead} onClick={()=>void save({resetAvatar:true,revision:editRevision})}><SafeAssetImage src={DEFAULT_IMAGE} style={{width:64,height:64,objectFit:"cover",borderRadius:"50%"}} alt="" fallback={<IconUserCircle size={48}/>}/><span>默认形象</span></button><button type="button" disabled={busy||needsRead} onClick={()=>fileRef.current?.click()}><IconUpload size={34} stroke={1.4}/><span>{busy?"保存中…":"上传图片"}</span></button></div><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e=>{void upload(e.target.files?.[0]);e.target.value="";}}/><div className="feed-agent-editor-actions"><button type="button" className="feed-secondary" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div></>}
    </div>}
    {!editing&&<div className="feed-agent-content" role="region" aria-label={TABS.find(item=>item.id===tab)?.label}>
      {tab==="activity"&&<>{jobs.map((job,i)=><Fragment key={job.id}>{(!i||dateKey(job.createdAt)!==dateKey(jobs[i-1].createdAt))&&<h3 className="feed-agent-day">{day(job.createdAt)}</h3>}<article className="feed-agent-event"><span className="feed-agent-event-icon"><img src="/uploads/feature/feed/time.webp" width={36} height={36} alt=""/></span><div><h4>{STATUS[job.status]}</h4><p>{description(job)}</p>{i===0&&sourceErrors.map(source=><p className="feed-source-status" key={source.personId}>{data.peopleCatalog?.find(person=>person.id===source.personId)?.name}：{source.error}</p>)}<time dateTime={job.createdAt}>{time(job.createdAt)}</time>{job.status==="error"&&job.id===data.job?.id&&<button type="button" className="feed-agent-retry" disabled={refreshDisabled} onClick={onRefresh}>重试更新</button>}</div></article></Fragment>)}{!jobs.length&&<p className="feed-agent-empty">{historyLoading?"正在读取…":"暂无更新记录"}</p>}{!jobs.length&&sourceErrors.map(source=><p className="feed-source-status" key={source.personId}>{data.peopleCatalog?.find(person=>person.id===source.personId)?.name}：{source.error}</p>)}{historyError&&<p className="feed-error" role="alert">{historyError}<button type="button" disabled={historyLoading} onClick={()=>setHistoryRead(value=>value+1)}>重试读取</button></p>}{history?.nextCursor&&<button type="button" className="feed-agent-older" disabled={historyLoading} onClick={()=>void older()}>{historyLoading?"正在读取…":"查看更早记录"}</button>}</>}
      {tab==="sources"&&<>{data.group?.mode==="people"?data.peopleCatalog?.filter(person=>data.group?.people?.includes(person.id)).map(person=><div className="feed-agent-source" key={person.id}><SafeAssetImage src={person.avatar} style={{width:48,height:48,objectFit:"cover",borderRadius:"50%"}} alt="" fallback={<IconUserCircle size={32}/>}/><div><h4>{person.name}</h4><p>{person.platform} · {person.handle}</p></div></div>):<><div className="feed-agent-fact"><span>关注内容</span><p>{data.preferences.instructions||"尚未设置"}</p></div>{data.group?.subscriptions.map(source=><a className="feed-agent-source-link" key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>)}</>}</>}
      {tab==="services"&&<><div className="feed-agent-fact"><span>动态模板</span><p>{data.group?.mode==="people"?"名人原帖":"新闻动态"}</p></div><div className="feed-agent-fact"><span>当前状态</span><p>{feedJobRunning(data.job)?STATUS[data.job!.status]:data.job?.status==="error"?"更新未完成":"空闲"}</p></div>{data.group?.mode!=="people"&&<div className="feed-agent-fact"><span>大模型</span><p>{data.capabilities.generate?"已配置":"未配置"}</p></div>}</>}
      {tab==="schedule"&&<><div className="feed-agent-fact"><span>自动更新</span><p>{data.preferences.enabled?"已开启":"已关闭"}</p></div><div className="feed-agent-fact"><span>更新间隔</span><p>每 {data.preferences.intervalMinutes} 分钟</p></div>{data.job&&<div className="feed-agent-fact"><span>最近更新</span><p>{day(data.job.updatedAt)} {time(data.job.updatedAt)}</p></div>}</>}
      {tab==="identity"&&<><button type="button" className="feed-agent-fact feed-agent-fact-button" onClick={()=>edit("name")}><span>名称</span><p>{profile.name}<IconPencil size={18}/></p></button><button type="button" className="feed-agent-fact feed-agent-fact-button" onClick={()=>edit("avatar")}><span>虚拟形象</span><p>{profile.image?"自定义形象":"Alcor"}<IconPencil size={18}/></p></button></>}
    </div>}
  </AppModal>;
}
