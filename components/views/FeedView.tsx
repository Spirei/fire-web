"use client";

import { useCallback,useEffect,useRef,useState } from "react";
import { IconAdjustmentsHorizontal,IconArrowDown,IconArrowUp,IconCheck,IconDots,IconHeart,IconMessageCircle,IconRefresh } from "@tabler/icons-react";
import AppModal from "@/components/AppModal";
import SafeAssetImage from "@/components/SafeAssetImage";
import type { FeedIcon,FeedJob,FeedMessage,FeedPayload,FeedPost } from "@/lib/feedTypes";
import { observePanelVisibility,panelIsShown } from "@/lib/panelVisibility";
import { feedRequest as api,FeedRequestError,feedJobRunning as running,feedEmptyCopy } from "@/lib/feedClient";
import "@/styles/feed.css";

const ICON_URL=(icon:FeedIcon)=>`/uploads/feature/feed/${icon}.webp`;
const JOB_LABEL={queued:"已排队",searching:"正在搜集来源",writing:"正在提炼动态",done:"更新完成",error:"更新未完成"};
function dateText(value:string|null) {return value?value.slice(0,10).replaceAll("-","/"):"日期未提供";}
function relative(value:string,now:number) {const n=Math.max(0,now-Date.parse(value));return n<60_000?"刚刚":n<3600_000?`${Math.floor(n/60_000)}分钟前`:n<86400_000?`${Math.floor(n/3600_000)}小时前`:`${Math.floor(n/86400_000)}天前`;}

function Mascot({image,video,onClick}:{image:string;video:string|null;onClick:()=>void}) {
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false),[reduced,setReduced]=useState(true);
  const videoRef=useRef<HTMLVideoElement>(null),buttonRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const media=matchMedia("(prefers-reduced-motion: reduce)");const sync=()=>setReduced(media.matches);sync();media.addEventListener("change",sync);return()=>media.removeEventListener("change",sync);},[]);
  useEffect(()=>{
    const sync=()=>{const element=videoRef.current;if(!element)return;if(document.hidden||reduced||!panelIsShown(buttonRef.current))element.pause();else void element.play().catch(()=>undefined);};
    const release=buttonRef.current?observePanelVisibility(buttonRef.current,sync):()=>{};
    document.addEventListener("visibilitychange",sync);sync();return()=>{release();document.removeEventListener("visibilitychange",sync);};
  },[reduced,video]);
  return <button ref={buttonRef} type="button" className="feed-mascot" onClick={onClick} aria-label="查看 Alcor 动态任务" title="Alcor">
    <SafeAssetImage src={image} style={{width:"100%",height:"100%"}} className="feed-mascot-poster" alt="Alcor" fallback={<span>A</span>} />
    {video&&!failed&&!reduced&&<video ref={videoRef} src={video} muted autoPlay loop playsInline preload="metadata" aria-hidden="true" onCanPlay={()=>{setReady(true);if(document.hidden||!panelIsShown(buttonRef.current))videoRef.current?.pause();}} onError={()=>setFailed(true)} className={`feed-mascot-video ${ready?"is-ready":""}`} />}
  </button>;
}

export default function FeedView({initial=null,initialNow=0}:{initial?:FeedPayload|null;initialNow?:number}) {
  const [data,setData]=useState(initial),[now,setNow]=useState(initialNow),[error,setError]=useState("");
  const [errorAction,setErrorAction]=useState<"load"|"refresh"|null>(null),[promptError,setPromptError]=useState(""),[conflict,setConflict]=useState(false),[recovering,setRecovering]=useState(false);
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(""),[draftRevision,setDraftRevision]=useState(0),[enabled,setEnabled]=useState(true),[saving,setSaving]=useState(false);
  const [requesting,setRequesting]=useState(false),[loadingMore,setLoadingMore]=useState(false),[tasks,setTasks]=useState(false),[selected,setSelected]=useState<FeedPost|null>(null),[menu,setMenu]=useState<FeedPost|null>(null);
  const [messages,setMessages]=useState<FeedMessage[]>([]),[question,setQuestion]=useState(""),[sending,setSending]=useState(false),[discussionLoading,setDiscussionLoading]=useState(false),[discussionError,setDiscussionError]=useState("");
  const [pendingQuestion,setPendingQuestion]=useState(""),[newReply,setNewReply]=useState(false),[discussionNeedsRead,setDiscussionNeedsRead]=useState(false);
  const [pendingPosts,setPendingPosts]=useState<Record<string,boolean>>({});
  const [undoPost,setUndoPost]=useState<FeedPost|null>(null);
  const [shown,setShown]=useState(true);
  const root=useRef<HTMLElement>(null),loadedCount=useRef(initial?.posts.length||20);
  const discussionLog=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),discussionController=useRef<AbortController|null>(null),live=useRef(true);
  const loadEpoch=useRef(0),readController=useRef<AbortController|null>(null),moreController=useRef<AbortController|null>(null),pendingIds=useRef(new Set<string>());
  const following=useRef(true),readSince=useRef(0),requestLock=useRef(false),saveLock=useRef(false),sendLock=useRef(false);
  loadedCount.current=data?.posts.length||20;
  useEffect(()=>{const sync=()=>setShown(panelIsShown(root.current));sync();return root.current?observePanelVisibility(root.current,sync):undefined;},[]);
  function invalidateReads(){++loadEpoch.current;readController.current?.abort();moreController.current?.abort();}
  useEffect(()=>{if(!shown){invalidateReads();discussionController.current?.abort();sendLock.current=false;setEditing(false);setTasks(false);setMenu(null);setSelected(null);setSending(false);setPendingQuestion("");}},[shown]);
  const load=useCallback(async()=>{
    if(pendingIds.current.size||saveLock.current||!panelIsShown(root.current))return;
    readController.current?.abort();moreController.current?.abort();
    const controller=new AbortController();readController.current=controller;readSince.current=Date.now();
    const epoch=++loadEpoch.current,target=Math.max(20,loadedCount.current);
    try{
      const next=await api<FeedPayload>(`?limit=${Math.min(50,target)}`,"GET",undefined,controller.signal);
      while(next.nextCursor&&next.posts.length<target&&epoch===loadEpoch.current){
        const page=await api<FeedPayload>(`?limit=${Math.min(50,target-next.posts.length)}&cursor=${encodeURIComponent(next.nextCursor)}`,"GET",undefined,controller.signal);
        next.posts.push(...page.posts.filter(p=>!next.posts.some(old=>old.id===p.id)));
        if(!page.posts.length||page.nextCursor===next.nextCursor){next.nextCursor=null;break;}
        next.nextCursor=page.nextCursor;
      }
      if(!live.current||epoch!==loadEpoch.current)return;
      setData(next);setError("");setErrorAction(null);
    }catch(e){if(live.current&&!controller.signal.aborted&&epoch===loadEpoch.current){setError((e as Error).message);setErrorAction("load");}}
    finally{if(readController.current===controller)readController.current=null;}
  },[]);
  useEffect(()=>{live.current=true;if(!initial)void load();const timer=setInterval(()=>{if(!document.hidden&&panelIsShown(root.current))setNow(Date.now());},60_000);setNow(Date.now());return()=>{live.current=false;++loadEpoch.current;readController.current?.abort();moreController.current?.abort();discussionController.current?.abort();clearInterval(timer);};},[load,initial]);
  useEffect(()=>{
    if(!shown||!running(data?.job||null))return;
    const controller=new AbortController();let stopped=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(stopped)return;
      try{if(!document.hidden){
        const next=await api<FeedJob>(`/jobs/${data!.job!.id}`,"GET",undefined,controller.signal);
        if(!controller.signal.aborted&&!pendingIds.current.size&&!saveLock.current){
          setData(p=>p&&p.job?.id===next.id?{...p,job:next}:p);
          if(!running(next))void load();
        }
      }}catch(e){if(!controller.signal.aborted){setError((e as Error).message);setErrorAction("load");}}
      if(!stopped)timer=setTimeout(poll,2500);
    };
    timer=setTimeout(poll,2500);return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[data?.job?.id,data?.job?.status,load,shown]);
  useEffect(()=>{const sync=()=>{if(document.hidden||!panelIsShown(root.current)){readController.current?.abort();moreController.current?.abort();return;}if(Date.now()-readSince.current>2000&&!pendingIds.current.size&&!saveLock.current&&!requestLock.current)void load();};document.addEventListener("visibilitychange",sync);window.addEventListener("focus",sync);const release=root.current?observePanelVisibility(root.current,sync):()=>{};return()=>{release();document.removeEventListener("visibilitychange",sync);window.removeEventListener("focus",sync);};},[load]);
  useEffect(()=>{const log=discussionLog.current;if(!log)return;if(following.current)log.scrollTop=log.scrollHeight;else setNewReply(true);},[messages,pendingQuestion,discussionLoading]);
  useEffect(()=>{const element=composer.current;if(element){element.style.height="auto";element.style.height=`${Math.min(112,element.scrollHeight)}px`;}},[question,selected]);
  function edit() {if(!data)return;setDraft(data.preferences.instructions);setDraftRevision(data.preferences.revision);setEnabled(data.preferences.enabled||!data.preferences.instructions);setPromptError("");setConflict(false);setEditing(true);}
  async function refresh(afterSave=false) {
    if(requestLock.current||(!afterSave&&running(data?.job||null)))return;
    requestLock.current=true;setRequesting(true);setError("");
    try{const job=await api<FeedJob>("/refresh","POST",{});invalidateReads();if(live.current)setData(prev=>prev?{...prev,job}:prev);}
    catch(e){if(live.current){setError((e as Error).message);setErrorAction(e instanceof FeedRequestError&&e.unconfirmed?"load":"refresh");}}finally{requestLock.current=false;if(live.current)setRequesting(false);}
  }
  async function save() {
    if(saveLock.current||conflict)return;saveLock.current=true;setSaving(true);setPromptError("");
    try{const pref=await api<FeedPayload["preferences"]>("/preferences","PUT",{instructions:draft,revision:draftRevision,enabled});invalidateReads();if(!live.current)return;setData(p=>p?{...p,preferences:pref,job:null}:p);setEditing(false);if(pref.instructions&&data?.capabilities.generate)await refresh(true);}
    catch(e){if(live.current){setPromptError((e as Error).message);setConflict(e instanceof FeedRequestError&&(e.status===409||e.unconfirmed));}}finally{saveLock.current=false;if(live.current)setSaving(false);}
  }
  async function recoverDraft(){
    if(recovering)return;setRecovering(true);
    try{const next=await api<FeedPayload>();if(!live.current)return;invalidateReads();setData(p=>p?{...p,preferences:next.preferences,job:next.job}:next);setDraftRevision(next.preferences.revision);setConflict(false);setPromptError(draft.trim()===next.preferences.instructions&&(!draft.trim()||enabled===next.preferences.enabled)?"已确认这份指示已保存。可关闭弹窗，再按需更新动态。":"已读取最新版本，你的草稿仍保留。确认后再保存。");}
    catch(e){if(live.current)setPromptError((e as Error).message);}finally{if(live.current)setRecovering(false);}
  }
  async function updatePost(post:FeedPost,patch:{liked?:boolean;hidden?:boolean}) {
    if(pendingIds.current.has(post.id))return;
    pendingIds.current.add(post.id);invalidateReads();
    setPendingPosts(p=>({...p,[post.id]:true}));
    setData(p=>p?{...p,posts:p.posts.map(item=>item.id===post.id?{...item,...patch}:item)}:p);
    try{
      const saved=await api<FeedPost>(`/posts/${post.id}`,"PUT",patch);if(!live.current)return;invalidateReads();
      setData(p=>{
        if(!p)return p;
        let posts=p.posts.filter(item=>item.id!==saved.id);
        if(!saved.hidden)posts=[...posts,saved].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
        return {...p,posts};
      });
      if(patch.hidden===true)setUndoPost(saved);
      else if(patch.hidden===false)setUndoPost(null);
    }
    catch(e){if(live.current){invalidateReads();setData(p=>p?{...p,posts:p.posts.map(item=>item.id===post.id?post:item)}:p);setError((e as Error).message);setErrorAction("load");}}
    finally{pendingIds.current.delete(post.id);if(live.current)setPendingPosts(p=>({...p,[post.id]:false}));}
  }
  async function more() {
    if(!data?.nextCursor||moreController.current)return;setLoadingMore(true);
    const controller=new AbortController();moreController.current=controller;
    const epoch=loadEpoch.current;
    try{const next=await api<FeedPayload>(`?cursor=${encodeURIComponent(data.nextCursor)}`,"GET",undefined,controller.signal);if(live.current&&epoch===loadEpoch.current){setData(p=>p?{...p,posts:[...p.posts,...next.posts.filter(n=>!p.posts.some(old=>old.id===n.id))],nextCursor:next.nextCursor}:next);setError("");}}
    catch(e){if(live.current&&!controller.signal.aborted&&epoch===loadEpoch.current){setError((e as Error).message);setErrorAction(null);}}finally{if(moreController.current===controller)moreController.current=null;if(live.current)setLoadingMore(false);}
  }
  async function discuss(post:FeedPost) {
    discussionController.current?.abort();const controller=new AbortController();discussionController.current=controller;
    following.current=true;sendLock.current=false;setNewReply(false);setPendingQuestion("");setSending(false);
    setSelected(post);setMessages([]);setQuestion("");setDiscussionError("");setDiscussionNeedsRead(false);setDiscussionLoading(true);
    try{const result=await api<{messages:FeedMessage[]}>(`/posts/${post.id}/discussion`,"GET",undefined,controller.signal);if(!controller.signal.aborted)setMessages(result.messages);}
    catch(e){if(!controller.signal.aborted)setDiscussionError((e as Error).message);}finally{if(!controller.signal.aborted)setDiscussionLoading(false);}
  }
  async function rereadDiscussion(){
    if(!selected||discussionLoading||sendLock.current)return;
    const controller=new AbortController();discussionController.current?.abort();discussionController.current=controller;setDiscussionLoading(true);
    try{const result=await api<{messages:FeedMessage[]}>(`/posts/${selected.id}/discussion`,"GET",undefined,controller.signal);if(!controller.signal.aborted){setMessages(result.messages);setDiscussionError("");setDiscussionNeedsRead(false);if(result.messages.at(-2)?.text===question.trim()&&result.messages.at(-1)?.role==="assistant")setQuestion("");}}
    catch(e){if(!controller.signal.aborted)setDiscussionError((e as Error).message);}finally{if(!controller.signal.aborted)setDiscussionLoading(false);}
  }
  async function send() {
    if(!question.trim()||sendLock.current||discussionLoading||discussionNeedsRead||!selected)return;
    discussionController.current?.abort();sendLock.current=true;following.current=true;setNewReply(false);
    const post=selected,text=question.trim(),controller=new AbortController();discussionController.current=controller;setSending(true);setPendingQuestion(text);setQuestion("");setDiscussionError("");
    try{const result=await api<{messages:FeedMessage[]}>(`/posts/${post.id}/discussion`,"POST",{text},controller.signal,100_000);if(!controller.signal.aborted){setMessages(result.messages);setPendingQuestion("");}}
    catch(e){if(!controller.signal.aborted){setDiscussionError((e as Error).message);setDiscussionNeedsRead(e instanceof FeedRequestError&&e.unconfirmed);setQuestion(text);setPendingQuestion("");}}finally{if(live.current&&!controller.signal.aborted){sendLock.current=false;setSending(false);}}
  }
  function closeDiscussion(){discussionController.current?.abort();sendLock.current=false;setSelected(null);setSending(false);setPendingQuestion("");}
  const job=data?.job&&data.job.revision===data.preferences.revision?data.job:null,posts=data?.posts.filter(p=>!p.hidden)||[],empty=data?feedEmptyCopy({...data,job}):null;
  return <section ref={root} className="alcor-feed feed-theme" aria-label="动态">
    <div className="feed-mascot-top"><Mascot image={data?.capabilities.avatar.image||"/uploads/feature/feed/alcor.png"} video={data?.capabilities.avatar.video||null} onClick={()=>setTasks(true)} /></div>
    <header className="feed-header">
      <h1>动态</h1>
      <div className="feed-header-actions">
        {data?.preferences.instructions&&<button type="button" className={`feed-icon-button ${running(job)?"is-working":""}`} onClick={()=>void refresh()} disabled={requesting||running(job)||!data.capabilities.generate} title="更新动态" aria-label="更新动态"><IconRefresh size={19} stroke={1.8}/></button>}
        <button type="button" className="feed-icon-button feed-settings-button" onClick={edit} disabled={!data} title="编辑动态版块指示" aria-label="编辑动态版块指示"><IconAdjustmentsHorizontal size={21} stroke={1.8}/></button>
      </div>
    </header>
    {(error||job?.status==="error")&&!editing&&<p className="feed-status feed-error" role="alert">{error||job?.error}{(error?errorAction:!running(job)&&data?.capabilities.generate)&&<button type="button" disabled={requesting} onClick={()=>void (error&&errorAction==="load"?load():refresh())}>{error&&errorAction==="load"?"重新读取":"重试更新"}</button>}</p>}
    {running(job)&&<p className="feed-status" role="status"><span className="feed-status-dot"/>{JOB_LABEL[job!.status]}，完成后会显示在这里</p>}
    {!error&&job?.status==="done"&&now-Date.parse(job.updatedAt)<600_000&&<p className="feed-status feed-complete" role="status"><IconCheck size={15}/>{job.added?`已更新 ${job.added} 条动态`:"暂无新的动态，已有内容保持不变"}</p>}
    {undoPost&&<p className="feed-status feed-undo" role="status">已隐藏这条动态<button type="button" disabled={pendingPosts[undoPost.id]} onClick={()=>void updatePost(undoPost,{hidden:false})}>撤销</button><button type="button" aria-label="关闭隐藏提示" onClick={()=>setUndoPost(null)}>×</button></p>}
    {!data&&!error&&<div className="feed-skeleton" aria-label="正在加载动态"><i/><i/><i/></div>}
    <div className="feed-posts" role="feed" aria-busy={running(job)}>
      {posts.map(post=><article className="feed-post" key={post.id} aria-labelledby={`feed-title-${post.id}`}>
        <SafeAssetImage src={ICON_URL(post.icon)} alt="" loading="lazy" className="feed-post-icon" fallback={<span className="feed-icon-fallback">✦</span>} />
        <div className="feed-post-content">
          <div className="feed-post-heading"><h2 id={`feed-title-${post.id}`}>{post.title}</h2><time dateTime={post.createdAt} title={post.createdAt}>{relative(post.createdAt,now)}</time><button type="button" className="feed-more" aria-label={`${post.title}的选项`} onClick={()=>setMenu(post)}><IconDots size={17}/></button></div>
          <p className="feed-body">{post.segments.map((segment,i)=>{const source=post.sources.find(s=>s.id===segment.sourceId);return source?<a key={i} href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.publisher} · ${dateText(source.publishedAt)}`}>{segment.text}</a>:<span key={i}>{segment.text}</span>;})}</p>
          {post.media.length>0&&<div className="feed-media">{post.media.map((m,i)=>m.type==="image"?<a href={m.url} key={i} target="_blank" rel="noopener noreferrer"><img src={m.url} alt={m.alt} loading="lazy" /></a>:<video src={m.url} poster={m.poster} controls playsInline preload="none" key={i}/>)}</div>}
          <div className="feed-post-actions"><button type="button" aria-label={post.liked?"取消喜欢":"喜欢"} aria-pressed={post.liked} disabled={pendingPosts[post.id]} onClick={()=>void updatePost(post,{liked:!post.liked})} className={post.liked?"is-liked":""}><IconHeart size={21} stroke={1.8} fill={post.liked?"currentColor":"none"}/></button><button type="button" onClick={()=>void discuss(post)}><IconMessageCircle size={21} stroke={1.8}/><span>讨论</span></button><span className="feed-published">发稿 {dateText(post.publishedAt)}</span></div>
        </div>
      </article>)}
      {data&&posts.length===0&&<>
        <article className="feed-post feed-welcome"><SafeAssetImage src={ICON_URL("magic")} alt="" className="feed-post-icon" fallback={<span className="feed-icon-fallback">✦</span>}/><div className="feed-post-content"><h2>{empty?.title}</h2><p className="feed-body">{empty?.body}</p><button type="button" className="feed-inline-action" onClick={edit}>编辑动态指示 <IconAdjustmentsHorizontal size={16}/></button></div></article>
        <article className="feed-post feed-welcome"><SafeAssetImage src={ICON_URL("note")} alt="" className="feed-post-icon" fallback={<span className="feed-icon-fallback">✦</span>}/><div className="feed-post-content"><h2>简洁的内容，清楚的来源</h2><p className="feed-body">动态会保留发稿日期和可点击的来源。感兴趣就点喜欢，想了解更多就开始讨论。你的指示和讨论会同步到 App。</p>{!data.capabilities.generate&&<a className="feed-inline-action" href="/settings?sub=stocks&anchor=translation&from=services">先配置大模型服务 →</a>}</div></article>
      </>}
    </div>
    {data?.nextCursor&&<button type="button" className="feed-load-more" disabled={loadingMore} onClick={()=>void more()}>{loadingMore?"正在读取":"查看更早动态"}</button>}
    {editing&&data&&<AppModal title="动态版块说明" desc="你的动态由以下指示提供支持。对此提示做出的编辑将应用于今后的动态，不会改变已发布的内容。" size="md" className="feed-theme feed-themed-modal feed-prompt-modal" onClose={()=>setEditing(false)} closeDisabled={saving||recovering}>
      <label className="sr-only" htmlFor="feed-instructions">你的动态应该包含什么内容？</label><textarea id="feed-instructions" data-autofocus value={draft} onChange={e=>setDraft(e.target.value)} disabled={saving} maxLength={4000} placeholder="为我打造一个关于我兴趣的动态版块。关注美国大新闻、美股大事件和重要公司动向。保持内容简洁直接，标注发稿日期和来源，避免点击诱饵。" className="feed-instructions"/>
      <div className="feed-prompt-meta"><label htmlFor="feed-auto-update">定期更新<button id="feed-auto-update" type="button" role="switch" aria-checked={enabled} aria-label="定期更新" className={`feed-toggle ${enabled?"is-on":""}`} onClick={()=>setEnabled(v=>!v)} disabled={saving}><span style={{backgroundColor:"#fff"}}/></button></label><span>{draft.length.toLocaleString("en-US")}/4,000</span></div>
      <p className="feed-prompt-note">{!draft.trim()?"先写下你想关注的内容；清空指示会停止后续更新。":!data.capabilities.generate?"指示会保存到账号；配置大模型服务后即可更新。":enabled?`保存后立即更新，之后约每 ${Math.round(data.preferences.intervalMinutes/60*10)/10} 小时更新。`:"保存后更新一次，之后由你手动更新。"}</p>
      {promptError&&<p role="alert" className={conflict?"feed-error":"feed-prompt-note"}>{promptError}{conflict&&<button type="button" disabled={recovering} onClick={()=>void recoverDraft()}>{recovering?"正在读取":"读取最新版本，保留草稿"}</button>}</p>}
      <div className="feed-modal-actions"><button type="button" disabled={saving||recovering} onClick={()=>setEditing(false)}>取消</button><button type="button" className="feed-primary" onClick={()=>void save()} disabled={saving||recovering||conflict||(draft.trim()===data.preferences.instructions&&(!draft.trim()||enabled===data.preferences.enabled))}>{saving?"正在保存":"保存"}</button></div>
    </AppModal>}
    {tasks&&<AppModal title="Alcor 的动态任务" size="sm" className="feed-theme feed-themed-modal feed-small-modal" onClose={()=>setTasks(false)}><div className="feed-task-detail"><img src="/uploads/feature/feed/time.webp" alt=""/><h4>{job?JOB_LABEL[job.status]:data?.preferences.instructions?"指示已保存":"告诉我你想关注什么"}</h4><p>{job?.error||(job?.status==="done"?job.added?`新增 ${job.added} 条动态；已有内容保持不变。`:"暂无新的动态，已有内容保持不变。":running(job)?"正在搜集和提炼内容，可以离开页面，稍后回来查看。":"用右上角的指示塑造你的动态。")}</p>{job&&<small>更新于 <time dateTime={job.updatedAt}>{job.updatedAt.slice(0,16).replace("T"," ")} UTC</time></small>}</div><button type="button" className="feed-primary feed-task-button" onClick={()=>{setTasks(false);edit();}}>编辑动态指示</button></AppModal>}
    {menu&&<AppModal title="动态来源与选项" size="sm" className="feed-theme feed-themed-modal feed-small-modal" onClose={()=>setMenu(null)}><h4 className="feed-option-title">{menu.title}</h4><div className="feed-sources">{menu.sources.map(s=><a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<small>{s.publisher} · {dateText(s.publishedAt)}</small></a>)}</div><button type="button" className="feed-option-hide" disabled={pendingPosts[menu.id]} onClick={()=>{void updatePost(menu,{hidden:true});setMenu(null);}}>不再显示这条动态</button></AppModal>}
    {selected&&<AppModal title="讨论" desc={selected.title} size="lg" className="feed-theme feed-themed-modal feed-discussion-modal" onClose={closeDiscussion}>
      <div className="feed-discussion-area"><div className="feed-discussion-log" ref={discussionLog} role="log" aria-busy={sending||discussionLoading} onScroll={()=>{const log=discussionLog.current;if(log){following.current=log.scrollHeight-log.clientHeight-log.scrollTop<48;if(following.current)setNewReply(false);}}}>{discussionLoading&&!messages.length?<p className="feed-discussion-hint">正在读取讨论…</p>:messages.length===0&&!pendingQuestion?<p className="feed-discussion-hint">从这条动态聊起。你想了解什么？</p>:messages.map(m=><div key={m.id} className={`feed-message feed-message-${m.role}`}><small>{m.role==="user"?"你":"Alcor"}</small><p>{m.text}</p></div>)}{pendingQuestion&&<><div className="feed-message feed-message-user"><small>你 · 正在发送</small><p>{pendingQuestion}</p></div><p className="feed-thinking" role="status">Alcor 正在结合来源整理回答…</p></>}</div>
      {newReply&&<button type="button" className="feed-new-reply" onClick={()=>{following.current=true;setNewReply(false);const log=discussionLog.current;if(log)log.scrollTop=log.scrollHeight;}}><IconArrowDown size={14}/> 查看最新回复</button>}
      </div>
      {discussionError&&<p role="alert" className="feed-error">{discussionError}<button type="button" disabled={discussionLoading} onClick={()=>void rereadDiscussion()}>重新读取讨论</button></p>}
      <form className="feed-composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea ref={composer} rows={1} aria-label="讨论内容" value={question} onChange={e=>setQuestion(e.target.value)} maxLength={2000} placeholder={sending?"正在等待 Alcor 回答…":"问问 Alcor…"} disabled={sending||discussionLoading} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229&&!matchMedia("(pointer: coarse)").matches){e.preventDefault();void send();}}}/><button type="submit" className="feed-primary" disabled={!question.trim()||sending||discussionLoading||discussionNeedsRead} aria-label="发送讨论">{sending?<IconDots size={20}/>:<IconArrowUp size={20}/>}</button></form>
      <p className="feed-discussion-footnote"><IconCheck size={12}/> 讨论按动态独立保存，可在 App 继续</p>
    </AppModal>}
  </section>;
}
