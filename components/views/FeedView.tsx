"use client";

import { Fragment,useCallback,useEffect,useRef,useState } from "react";
import { IconAdjustmentsHorizontal,IconArrowDown,IconArrowUp,IconCheck,IconDots,IconHeart,IconMessageCircle,IconRefresh,IconPlus,IconX,IconRss } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useWorkspaceSearchParams as useSearchParams } from "@/lib/workspacePanel";
import AppModal from "@/components/AppModal";
import SafeAssetImage from "@/components/SafeAssetImage";
import { FEED_PAGE_SIZE } from "@/lib/feedTypes";
import type { FeedIcon,FeedJob,FeedMessage,FeedPayload,FeedPost,FeedGroup,FeedSubscription,FeedMode,FeedPersonId,FeedAgentProfile } from "@/lib/feedTypes";
import { observePanelVisibility,panelIsShown } from "@/lib/panelVisibility";
import { feedRequest as api,FeedRequestError,feedJobRunning as running,feedEmptyCopy } from "@/lib/feedClient";
import { feedBodyParts } from "@/lib/feedPresentation";
import FeedAgentPanel, { validFeedAgentTab, type FeedAgentTab } from "@/components/FeedAgentPanel";
import FeedMedia from "@/components/FeedMedia";
import FeedOriginalPost from "@/components/FeedOriginalPost";
import FeedTemplatePicker from "@/components/FeedTemplatePicker";
import FeedPeopleFilter from "@/components/FeedPeopleFilter";
import AppSelect from "@/components/AppSelect";
import { FEED_PEOPLE, feedPostTime, feedPersonHasUpdates, mergeFeedSeen } from "@/lib/feedPeopleConfig";
import { usePersistedState } from "@/lib/usePersistedState";
import { isUnseenPost, type SeenTimes } from "@/lib/tradingSquareSeen";

const ICON_URL=(icon:FeedIcon)=>`/uploads/feature/feed/${icon}.webp`;
function dateText(value:string|null) {return value?value.slice(0,10).replaceAll("-","/"):"日期未提供";}
function relative(value:string,now:number) {const n=Math.max(0,now-Date.parse(value));return n<60_000?"刚刚":n<3600_000?`${Math.floor(n/60_000)}分钟前`:n<86400_000?`${Math.floor(n/3600_000)}小时前`:`${Math.floor(n/86400_000)}天前`;}

function Mascot({image,video,name,onClick}:{image:string;video:string|null;name:string;onClick:()=>void}) {
  const [videoState,setVideoState]=useState({src:video,ready:false,failed:false}),[reduced,setReduced]=useState(true);
  if(videoState.src!==video)setVideoState({src:video,ready:false,failed:false});
  const ready=videoState.src===video&&videoState.ready,failed=videoState.src===video&&videoState.failed;
  const videoRef=useRef<HTMLVideoElement>(null),buttonRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const media=matchMedia("(prefers-reduced-motion: reduce)");const sync=()=>setReduced(media.matches);sync();media.addEventListener("change",sync);return()=>media.removeEventListener("change",sync);},[]);
  useEffect(()=>{
    const sync=()=>{const element=videoRef.current;if(!element)return;if(document.hidden||reduced||!panelIsShown(buttonRef.current))element.pause();else void element.play().catch(()=>undefined);};
    const release=buttonRef.current?observePanelVisibility(buttonRef.current,sync):()=>{};
    document.addEventListener("visibilitychange",sync);sync();return()=>{release();document.removeEventListener("visibilitychange",sync);};
  },[reduced,video]);
  // Intrinsic constraints survive the first paint, failed CSS delivery and bfcache restoration.
  return <button ref={buttonRef} type="button" className="feed-mascot" style={{position:"relative",display:"block",width:"var(--feed-mascot-size,72px)",height:"var(--feed-mascot-size,72px)",maxWidth:72,maxHeight:72,minWidth:0,minHeight:0,flex:"none",overflow:"hidden",borderRadius:"50%",padding:0}} onClick={onClick} aria-label={`查看 ${name} 的动态`} title={name}>
    <SafeAssetImage src={image} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}} className="feed-mascot-poster" alt={name} fallback={<span>A</span>} />
    {video&&!failed&&!reduced&&<video key={video} ref={videoRef} src={video} width={72} height={72} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",opacity:ready?1:0}} muted autoPlay loop playsInline preload="metadata" aria-hidden="true" onCanPlay={()=>{setVideoState(current=>current.src===video?{...current,ready:true}:current);if(document.hidden||!panelIsShown(buttonRef.current))videoRef.current?.pause();}} onError={()=>setVideoState(current=>current.src===video?{...current,failed:true}:current)} className={`feed-mascot-video ${ready?"is-ready":""}`} />}
  </button>;
}

export default function FeedView({initial=null,initialNow=0}:{initial?:FeedPayload|null;initialNow?:number}) {
  const search=useSearchParams(),groupId=search.get("feedGroup")||"default",author=search.get("feedPerson")||"";
  return <GroupFeedView key={groupId} groupId={groupId} author={author} initial={groupId==="default"&&!author?initial:null} initialNow={initialNow} initialAgent={initial?.agent} initialAvatar={initial?.capabilities.avatar}/>;
}
function GroupFeedView({initial,initialNow,groupId,author,initialAgent,initialAvatar}:{initial:FeedPayload|null;initialNow:number;groupId:string;author:string;initialAgent?:FeedAgentProfile;initialAvatar?:FeedPayload["capabilities"]["avatar"]}) {
  const router=useRouter(),search=useSearchParams(),tasks=search.get("feedAgent")==="profile",agentTab=validFeedAgentTab(search.get("feedAgentTab"));
  function agentView(open:boolean,tab:FeedAgentTab=agentTab) {const url=new URLSearchParams(search.toString());if(open){url.set("feedAgent","profile");if(tab!=="activity")url.set("feedAgentTab",tab);else url.delete("feedAgentTab");}else{url.delete("feedAgent");url.delete("feedAgentTab");}router.replace(`/trading?${url.toString()}`,{scroll:false});}
  const setTasks=(open:boolean)=>agentView(open);

  const groupPath=(path="")=>`${path}${path.includes("?")?"&":"?"}group=${encodeURIComponent(groupId)}${author?`&author=${encodeURIComponent(author)}`:""}`;
  const [data,setData]=useState(initial),[now,setNow]=useState(initialNow),[error,setError]=useState("");
  const [dataAuthor,setDataAuthor]=useState(author),readingPerson=dataAuthor!==author;
  const [groupName,setGroupName]=useState(""),[subscriptions,setSubscriptions]=useState<FeedSubscription[]>([]),[sourcesOpen,setSourcesOpen]=useState(false),[sourceName,setSourceName]=useState(""),[sourceUrl,setSourceUrl]=useState(""),[testingSource,setTestingSource]=useState(false),[sourceResult,setSourceResult]=useState("");
  const [mode,setMode]=useState<FeedMode>("news"),[people,setPeople]=useState<FeedPersonId[]>(["trump","duan"]),[autoUpdate,setAutoUpdate]=useState(true),[interval,setIntervalMinutes]=useState(360);
  const [newMode,setNewMode]=useState<FeedMode>("news"),[newPeople,setNewPeople]=useState<FeedPersonId[]>(["trump","duan"]);
  const [savedSeen,setSavedSeen]=usePersistedState<SeenTimes>(`fire:feed-people-seen:${groupId}`,{});
  const [visitSeen,setVisitSeen]=useState<SeenTimes>(savedSeen);
  const [avatarSeen,setAvatarSeen]=useState<SeenTimes>(savedSeen),[uploadingAvatar,setUploadingAvatar]=useState<FeedPersonId|null>(null);
  const seenReady=useRef(new Set<string>()),latestRead=useRef<SeenTimes>(savedSeen),initialRead=useRef(true);
  const [creating,setCreating]=useState(false),[newGroupName,setNewGroupName]=useState(""),[creatingGroup,setCreatingGroup]=useState(false),[groupError,setGroupError]=useState("");
  const [errorAction,setErrorAction]=useState<"load"|"refresh"|null>(null),[promptError,setPromptError]=useState(""),[conflict,setConflict]=useState(false),[recovering,setRecovering]=useState(false);
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState(""),[draftRevision,setDraftRevision]=useState(0),[saving,setSaving]=useState(false);
  const [requesting,setRequesting]=useState(false),[loadingMore,setLoadingMore]=useState(false),[selected,setSelected]=useState<FeedPost|null>(null),[menu,setMenu]=useState<FeedPost|null>(null);
  const [messages,setMessages]=useState<FeedMessage[]>([]),[question,setQuestion]=useState(""),[sending,setSending]=useState(false),[discussionLoading,setDiscussionLoading]=useState(false),[discussionError,setDiscussionError]=useState("");
  const [pendingQuestion,setPendingQuestion]=useState(""),[newReply,setNewReply]=useState(false),[discussionNeedsRead,setDiscussionNeedsRead]=useState(false);
  const [pendingPosts,setPendingPosts]=useState<Record<string,boolean>>({});
  const [undoPost,setUndoPost]=useState<FeedPost|null>(null);
  const [shown,setShown]=useState(true);
  const root=useRef<HTMLElement>(null),loadedCount=useRef(initial?.posts.length||FEED_PAGE_SIZE);
  const discussionLog=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),discussionController=useRef<AbortController|null>(null),live=useRef(true);
  const loadEpoch=useRef(0),readController=useRef<AbortController|null>(null),moreController=useRef<AbortController|null>(null),pendingIds=useRef(new Set<string>());
  const following=useRef(true),readSince=useRef(0),requestLock=useRef(false),saveLock=useRef(false),sendLock=useRef(false);
  if(!readingPerson)loadedCount.current=data?.posts.length||FEED_PAGE_SIZE;
  useEffect(()=>{const sync=()=>setShown(panelIsShown(root.current));sync();return root.current?observePanelVisibility(root.current,sync):undefined;},[]);
  function invalidateReads(){++loadEpoch.current;readController.current?.abort();moreController.current?.abort();}
  useEffect(()=>{if(!shown){invalidateReads();discussionController.current?.abort();sendLock.current=false;setEditing(false);setMenu(null);setSelected(null);setSending(false);setPendingQuestion("");}},[shown]);
  const load=useCallback(async(quiet=false)=>{
    if(pendingIds.current.size||saveLock.current||requestLock.current||!panelIsShown(root.current))return;
    readController.current?.abort();moreController.current?.abort();
    const controller=new AbortController();readController.current=controller;readSince.current=Date.now();
    const epoch=++loadEpoch.current,target=Math.max(FEED_PAGE_SIZE,loadedCount.current);
    try{
      const next=await api<FeedPayload>(groupPath(`?limit=${Math.min(50,target)}`),"GET",undefined,controller.signal);
      while(next.nextCursor&&next.posts.length<target&&epoch===loadEpoch.current){
        const page=await api<FeedPayload>(groupPath(`?limit=${Math.min(50,target-next.posts.length)}&cursor=${encodeURIComponent(next.nextCursor)}`),"GET",undefined,controller.signal);
        next.posts.push(...page.posts.filter(p=>!next.posts.some(old=>old.id===p.id)));
        if(!page.posts.length||page.nextCursor===next.nextCursor){next.nextCursor=null;break;}
        next.nextCursor=page.nextCursor;
      }
      if(!live.current||epoch!==loadEpoch.current)return;
      setData(next);setDataAuthor(author);setError("");setErrorAction(null);
    }catch(e){if(live.current&&!controller.signal.aborted&&epoch===loadEpoch.current&&(!quiet||(e instanceof FeedRequestError&&e.status===401))){setError((e as Error).message);setErrorAction("load");}}
    finally{if(readController.current===controller)readController.current=null;}
  },[groupId,author]);
  useEffect(()=>{loadedCount.current=FEED_PAGE_SIZE;live.current=true;if(!initial||!initialRead.current)void load();initialRead.current=false;const timer=setInterval(()=>{if(!document.hidden&&panelIsShown(root.current)){setNow(Date.now());if(!readController.current)void load(true);}},60_000);setNow(Date.now());return()=>{live.current=false;++loadEpoch.current;readController.current?.abort();moreController.current?.abort();discussionController.current?.abort();clearInterval(timer);};},[load,initial]);
  useEffect(()=>{
    // A switch blocked by an in-flight like/save must resume when that write finishes.
    if(readingPerson&&shown&&!requesting&&!saving&&!Object.values(pendingPosts).some(Boolean)&&(!readController.current||readController.current.signal.aborted))void load();
  },[readingPerson,shown,requesting,saving,pendingPosts,load]);
  useEffect(()=>{
    setAvatarSeen(previous=>mergeFeedSeen(previous,savedSeen));
    latestRead.current=mergeFeedSeen(latestRead.current,savedSeen);
  },[savedSeen]);
  useEffect(()=>{
    if(!shown||readingPerson||data?.group?.mode!=="people")return;
    const visible=data.posts.filter(post=>post.original&&(!author||post.original.person.id===author));
    const first:SeenTimes={},read:SeenTimes={};
    for(const [id,time] of Object.entries(data.peopleLatestAt||{}))if(time&&!seenReady.current.has(id)&&!savedSeen[id]){first[id]=time;seenReady.current.add(id);}
    for(const post of visible){const id=post.original!.person.id,time=post.publishedAt;if(!time)continue;
      if(!seenReady.current.has(id)&&!savedSeen[id])first[id]=!first[id]||time>first[id]! ? time:first[id];
      if(!read[id]||time>read[id]!)read[id]=time;
    }
    for(const post of visible)seenReady.current.add(post.original!.person.id);
    if(Object.keys(first).length)setVisitSeen(previous=>({...previous,...first}));
    setAvatarSeen(previous=>mergeFeedSeen(previous,{...first,...(author&&read[author]?{[author]:read[author]}:{})}));
    const next=mergeFeedSeen(latestRead.current,{...first,...read});
    if(next!==latestRead.current){latestRead.current=next;setSavedSeen(previous=>mergeFeedSeen(previous,next));}
  },[data?.posts,data?.peopleLatestAt,author,shown,readingPerson,setSavedSeen]);
  useEffect(()=>()=>{if(Object.keys(latestRead.current).length)setSavedSeen(previous=>mergeFeedSeen(previous,latestRead.current));},[setSavedSeen]);
  useEffect(()=>{if(!shown&&Object.keys(latestRead.current).length)setSavedSeen(previous=>mergeFeedSeen(previous,latestRead.current));},[shown,setSavedSeen]);
  useEffect(()=>{
    if(!shown||!running(data?.job||null))return;
    const controller=new AbortController();let stopped=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      if(stopped)return;
      try{if(!document.hidden){
        const next=await api<FeedJob>(`/jobs/${data!.job!.id}`,"GET",undefined,controller.signal);
        if(!controller.signal.aborted&&!pendingIds.current.size&&!saveLock.current){
          setData(p=>p&&p.job?.id===next.id?{...p,job:next}:p);
          if(!running(next))void load(true);
        }
      }}catch{/* A background read failure must not replace the current feed. */}
      if(!stopped)timer=setTimeout(poll,2500);
    };
    timer=setTimeout(poll,2500);return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[data?.job?.id,data?.job?.status,load,shown]);
  useEffect(()=>{const sync=()=>{if(document.hidden||!panelIsShown(root.current)){readController.current?.abort();moreController.current?.abort();return;}if(Date.now()-readSince.current>30_000&&!pendingIds.current.size&&!saveLock.current&&!requestLock.current)void load(true);};document.addEventListener("visibilitychange",sync);window.addEventListener("focus",sync);window.addEventListener("pageshow",sync);const release=root.current?observePanelVisibility(root.current,sync):()=>{};return()=>{release();document.removeEventListener("visibilitychange",sync);window.removeEventListener("focus",sync);window.removeEventListener("pageshow",sync);};},[load]);
  useEffect(()=>{
    const sync=(event:Event)=>{
      const detail=(event as CustomEvent<{id?:string;avatar?:string}>).detail;
      if(!detail?.id||!detail.avatar||!FEED_PEOPLE.some(person=>person.id===detail.id))return;
      const {id,avatar}=detail;
      setData(previous=>previous?{...previous,peopleCatalog:(previous.peopleCatalog||FEED_PEOPLE).map(person=>person.id===id?{...person,avatar}:person),posts:previous.posts.map(post=>post.original&&post.original.person.id===id?{...post,original:{...post.original,person:{...post.original.person,avatar}}}:post)}:previous);
    };
    window.addEventListener("fire:celebs-avatar-updated",sync);
    return()=>window.removeEventListener("fire:celebs-avatar-updated",sync);
  },[]);
  useEffect(()=>{const log=discussionLog.current;if(!log)return;if(following.current)log.scrollTop=log.scrollHeight;else setNewReply(true);},[messages,pendingQuestion,discussionLoading]);
  useEffect(()=>{const element=composer.current;if(element){element.style.height="auto";element.style.height=`${Math.min(112,element.scrollHeight)}px`;}},[question,selected]);
  function chooseGroup(id:string){if(id===groupId)return;invalidateReads();const url=new URL(window.location.href);url.searchParams.delete("feedPerson");if(id==="default")url.searchParams.delete("feedGroup");else url.searchParams.set("feedGroup",id);router.replace(url.pathname+url.search,{scroll:false});}
  function choosePerson(id:string){if(id===author)return;invalidateReads();setError("");setErrorAction(null);loadedCount.current=FEED_PAGE_SIZE;const url=new URL(window.location.href);if(id)url.searchParams.set("feedPerson",id);else url.searchParams.delete("feedPerson");router.replace(url.pathname+url.search,{scroll:false});}
  async function createGroup(){if(creatingGroup||!newGroupName.trim())return;setCreatingGroup(true);setGroupError("");try{const group=await api<FeedGroup>("/groups","POST",{name:newGroupName.trim(),mode:newMode,people:newPeople});if(live.current){setCreating(false);chooseGroup(group.id);}}catch(e){if(live.current)setGroupError((e as Error).message);}finally{if(live.current)setCreatingGroup(false);}}
  function edit() {if(!data)return;setGroupName(data.group?.name||"动态");setMode(data.group?.mode||"news");setPeople(data.group?.people||["trump","duan"]);setAutoUpdate(data.preferences.enabled);setIntervalMinutes(data.preferences.intervalMinutes);setSubscriptions(data.group?.subscriptions||[]);setSourcesOpen(false);setSourceName("");setSourceUrl("");setSourceResult("");setDraft(data.preferences.instructions);setDraftRevision(data.preferences.revision);setPromptError("");setConflict(false);setEditing(true);}
  async function uploadAvatar(id:FeedPersonId,file:File) {
    if(uploadingAvatar||!data?.capabilities.editPeopleAvatars)return;
    if(file.size>2*1024*1024){setPromptError("图片最大 2MB");return;}
    setUploadingAvatar(id);setPromptError("");
    try {
      const form=new FormData();form.append("id",id);form.append("file",file);
      const response=await fetch("/api/celebs/avatar",{method:"POST",body:form,signal:AbortSignal.timeout(20_000)});
      const result=await response.json();if(!response.ok||!result.avatar)throw new Error(result.error||"头像上传失败");
      if(!live.current)return;
      window.dispatchEvent(new CustomEvent("fire:celebs-avatar-updated",{detail:{id,avatar:result.avatar}}));
    }catch(error){if(live.current)setPromptError((error as Error).message);}finally{if(live.current)setUploadingAvatar(null);}
  }
  async function addSource(){if(testingSource||!sourceName.trim()||!sourceUrl.trim()||subscriptions.length>=8)return;if(subscriptions.some(s=>s.url===sourceUrl.trim())){setSourceResult("本组已添加这个订阅源。");return;}setTestingSource(true);setSourceResult("");try{const result=await api<{title:string;count:number;url:string}>("/subscriptions/test","POST",{name:sourceName.trim(),url:sourceUrl.trim()},undefined,20000);if(!live.current)return;setSubscriptions(prev=>prev.some(s=>s.url===result.url)?prev:[...prev,{name:sourceName.trim(),url:result.url}]);setSourceName("");setSourceUrl("");setSourceResult(`已读到 ${result.count} 条，保存后加入本组。`);}catch(e){if(live.current)setSourceResult((e as Error).message);}finally{if(live.current)setTestingSource(false);}}
  async function refresh(afterSave=false) {
    if(requestLock.current||(!afterSave&&running(data?.job||null)))return;
    requestLock.current=true;setRequesting(true);setError("");
    try{const job=await api<FeedJob>(groupPath("/refresh"),"POST",{});invalidateReads();if(live.current)setData(prev=>prev?{...prev,job}:prev);}
    catch(e){if(live.current){setError((e as Error).message);setErrorAction(e instanceof FeedRequestError&&e.unconfirmed?"load":"refresh");}}finally{requestLock.current=false;if(live.current)setRequesting(false);}
  }
  async function save() {
    if(saveLock.current||conflict)return;let saved=false;saveLock.current=true;setSaving(true);setPromptError("");
    try{const pref=await api<FeedPayload["preferences"]>(groupPath("/preferences"),"PUT",{instructions:draft,revision:draftRevision,name:groupName,subscriptions,mode,people,enabled:autoUpdate,intervalMinutes:interval});saved=true;invalidateReads();if(!live.current)return;setData(p=>p?{...p,preferences:pref,group:p.group?{...p.group,name:groupName,subscriptions,mode,people,revision:pref.revision}:p.group,groups:p.groups?.map(g=>g.id===groupId?{...g,name:groupName,subscriptions,mode,people,revision:pref.revision}:g),job:null,posts:(p.group?.mode||"news")!==mode?[]:p.posts,nextCursor:(p.group?.mode||"news")!==mode?null:p.nextCursor}:p);setEditing(false);if(mode==="people"||(pref.instructions&&data?.capabilities.generate))await refresh(true);}
    catch(e){if(live.current){setPromptError((e as Error).message);setConflict(e instanceof FeedRequestError&&(e.status===409||e.unconfirmed));}}finally{saveLock.current=false;if(live.current){setSaving(false);if(saved&&author&&(mode!=="people"||!people.includes(author as FeedPersonId)))choosePerson("");else void load(true);}}
  }
  async function recoverDraft(){
    if(recovering)return;setRecovering(true);
    try{const next=await api<FeedPayload>(groupPath());if(!live.current)return;invalidateReads();setData(p=>p?{...p,preferences:next.preferences,group:next.group,groups:next.groups,job:next.job}:next);setDraftRevision(next.preferences.revision);setConflict(false);setPromptError(draft.trim()===next.preferences.instructions?"已确认这份指示已保存。可关闭弹窗。":"已读取最新版本，你的草稿仍保留。确认后再保存。");}
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
        if(!saved.hidden)posts=[...posts,saved].sort((a,b)=>feedPostTime(b).localeCompare(feedPostTime(a))||b.id.localeCompare(a.id));
        return {...p,posts};
      });
      if(patch.hidden===true)setUndoPost(saved);
      else if(patch.hidden===false)setUndoPost(null);
    }
    catch(e){if(live.current){invalidateReads();setData(p=>p?{...p,posts:p.posts.map(item=>item.id===post.id?post:item)}:p);setError((e as Error).message);setErrorAction("load");}}
    finally{pendingIds.current.delete(post.id);if(live.current)setPendingPosts(p=>({...p,[post.id]:false}));}
  }
  async function more() {
    if(readingPerson||!data?.nextCursor||moreController.current)return;setLoadingMore(true);
    const controller=new AbortController();moreController.current=controller;
    const epoch=loadEpoch.current;
    try{const next=await api<FeedPayload>(groupPath(`?limit=${FEED_PAGE_SIZE}&cursor=${encodeURIComponent(data.nextCursor)}`),"GET",undefined,controller.signal);if(live.current&&epoch===loadEpoch.current){setData(p=>p?{...p,posts:[...p.posts,...next.posts.filter(n=>!p.posts.some(old=>old.id===n.id))],nextCursor:next.nextCursor}:next);setError("");}}
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
  const peopleMode=data?.group?.mode==="people",canRefresh=peopleMode||!!data?.capabilities.generate;
  const job=data?.job&&data.job.revision===data.preferences.revision?data.job:null,posts=readingPerson?[]:data?.posts.filter(p=>!p.hidden&&!!p.original===peopleMode&&(!author||p.original?.person.id===author))||[],empty=data&&!readingPerson?feedEmptyCopy({...data,job}):null;
  const isNew=(post:FeedPost)=>!!post.original&&!!visitSeen[post.original.person.id]&&isUnseenPost({author:post.original.person.id,date:post.publishedAt||""},visitSeen);
  const leadingNew=posts.findIndex(post=>!isNew(post));
  const changed=!!data&&(draft.trim()!==data.preferences.instructions||groupName.trim()!==(data.group?.name||"动态")||JSON.stringify(subscriptions)!==JSON.stringify(data.group?.subscriptions||[])||mode!==(data.group?.mode||"news")||JSON.stringify(people)!==JSON.stringify(data.group?.people||["trump","duan"])||autoUpdate!==data.preferences.enabled||interval!==data.preferences.intervalMinutes);
  return <section ref={root} className="alcor-feed feed-theme" aria-label="动态">
    <div className="feed-mascot-top">{data||initialAgent?<><Mascot name={data?.agent?.name||initialAgent?.name||"Alcor"} image={data?.capabilities.avatar.image||initialAvatar?.image||"/uploads/feature/feed/alcor.png"} video={data?data.capabilities.avatar.video:initialAvatar?.video||null} onClick={()=>setTasks(true)} /><button type="button" className="feed-mascot-name" onClick={()=>setTasks(true)}>{data?.agent?.name||initialAgent?.name||"Alcor"}</button></>:<div className="feed-mascot-placeholder" aria-hidden="true"/>}</div>
    <header className="feed-header">
      <h1>{data?.group?.name||"动态"}</h1>
      <div className="feed-header-actions">
        {(peopleMode||data?.preferences.instructions)&&<button type="button" className={`feed-icon-button ${running(job)?"is-working":""}`} onClick={()=>void refresh()} disabled={requesting||running(job)||!canRefresh} title="更新动态" aria-label="更新动态"><IconRefresh size={19} stroke={1.8}/></button>}
        <button type="button" className="feed-icon-button feed-settings-button" onClick={edit} disabled={!data} title="编辑动态模板与指示" aria-label="编辑动态模板与指示"><IconAdjustmentsHorizontal size={21} stroke={1.8}/></button>
      </div>
    </header>
    {data&&<nav className="feed-groups" aria-label="动态信息组">{(data.groups||[{id:"default",name:"动态"}]).map(g=><button key={g.id} type="button" aria-pressed={g.id===groupId} onClick={()=>chooseGroup(g.id)}>{g.name}</button>)}<button type="button" className="feed-group-add" aria-label="新建动态组" onClick={()=>{setNewGroupName("");setNewMode("news");setNewPeople(["trump","duan"]);setGroupError("");setCreating(true);}}><IconPlus size={16}/></button></nav>}
    {peopleMode&&<FeedPeopleFilter profiles={(data?.peopleCatalog||FEED_PEOPLE).filter(person=>data?.group?.people?.includes(person.id))} selected={author} unread={Object.fromEntries(FEED_PEOPLE.map(person=>[person.id,feedPersonHasUpdates(person.id,data?.peopleLatestAt,avatarSeen)]))} onSelect={choosePerson}/>}
    {error&&!editing&&<p className="feed-status feed-error" role="alert">{error}{errorAction&&<button type="button" disabled={requesting} onClick={()=>void (errorAction==="load"?load():refresh())}>{errorAction==="load"?"重新读取":"重试更新"}</button>}</p>}
    {undoPost&&<p className="feed-status feed-undo" role="status">已隐藏这条动态<button type="button" disabled={pendingPosts[undoPost.id]} onClick={()=>void updatePost(undoPost,{hidden:false})}>撤销</button><button type="button" aria-label="关闭隐藏提示" onClick={()=>setUndoPost(null)}>×</button></p>}
    {(!data||readingPerson)&&!error&&<div className="feed-skeleton" aria-label="正在加载动态"><i/><i/><i/></div>}
    <div className="feed-posts" role="feed" aria-busy={readingPerson||running(job)}>
      {posts.map((post,index)=><Fragment key={post.id}>{post.original?<FeedOriginalPost post={post} isNew={isNew(post)} busy={!!pendingPosts[post.id]} canDiscuss={!!data?.capabilities.generate} onMenu={()=>setMenu(post)} onLike={()=>void updatePost(post,{liked:!post.liked})} onDiscuss={()=>void discuss(post)}/>:<article className="feed-post" key={post.id} aria-labelledby={`feed-title-${post.id}`}>
        <SafeAssetImage src={ICON_URL(post.icon)} alt="" loading="lazy" className="feed-post-icon" fallback={<span className="feed-icon-fallback">✦</span>} />
        <div className="feed-post-content">
          <div className="feed-post-heading"><h2 id={`feed-title-${post.id}`}>{post.title}</h2><time dateTime={post.createdAt} title={post.createdAt}>{relative(post.createdAt,now)}</time><button type="button" className="feed-more" aria-label={`${post.title}的选项`} onClick={()=>setMenu(post)}><IconDots size={17}/></button></div>
          <p className="feed-body">{feedBodyParts(post.segments,post.sources).map((part,i)=>{const source=post.sources.find(s=>s.id===part.sourceId);return source?<a key={i} href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.publisher} · ${dateText(source.publishedAt)}`}>{part.text}</a>:<span key={i}>{part.text}</span>;})}</p>
          {post.media.length>0&&<FeedMedia media={post.media}/>}
          <div className="feed-post-actions"><button type="button" aria-label={post.liked?"取消喜欢":"喜欢"} aria-pressed={post.liked} disabled={pendingPosts[post.id]} onClick={()=>void updatePost(post,{liked:!post.liked})} className={post.liked?"is-liked":""}><IconHeart size={21} stroke={1.8} fill={post.liked?"currentColor":"none"}/></button><button type="button" onClick={()=>void discuss(post)}><IconMessageCircle size={21} stroke={1.8}/><span>讨论</span></button></div>
        </div>
      </article>}{peopleMode&&leadingNew>0&&index===leadingNew-1&&<div className="feed-unread-divider">以上 {leadingNew} 条为新动态</div>}</Fragment>)}
      {data&&!readingPerson&&!error&&posts.length===0&&<div className="feed-empty" role="status"><p>{empty?.title}</p><span>{empty?.body}</span>{!peopleMode&&!data.capabilities.generate&&<a className="feed-inline-action" href="/settings?sub=stocks&anchor=translation&from=services">配置大模型服务 →</a>}</div>}
    </div>
    {!readingPerson&&data?.nextCursor&&<button type="button" className="feed-load-more" disabled={loadingMore} onClick={()=>void more()}>{loadingMore?"正在读取":"查看更早动态"}</button>}
    {creating&&<AppModal title="新建动态组" size="sm" className="feed-theme feed-themed-modal feed-group-modal" onClose={()=>setCreating(false)} closeDisabled={creatingGroup}><label className="feed-config-label" htmlFor="feed-group-name">组名称</label><input id="feed-group-name" className="feed-config-input" value={newGroupName} onChange={e=>setNewGroupName(e.target.value)} maxLength={40} placeholder="例如：美国与美股、特朗普、段永平" data-autofocus disabled={creatingGroup}/><FeedTemplatePicker mode={newMode} people={newPeople} profiles={data?.peopleCatalog} disabled={creatingGroup} onMode={value=>{setNewMode(value);if(!newGroupName.trim()&&value==="people")setNewGroupName("名人动态");}} onPeople={setNewPeople}/>{groupError&&<p className="feed-error" role="alert">{groupError}</p>}<div className="feed-modal-actions"><button type="button" onClick={()=>setCreating(false)} disabled={creatingGroup}>取消</button><button type="button" className="feed-primary" disabled={creatingGroup||!newGroupName.trim()} onClick={()=>void createGroup()}>{creatingGroup?"正在创建":"创建"}</button></div></AppModal>}
    {editing&&data&&<AppModal title="动态模板与指示" size="md" className="feed-theme feed-themed-modal feed-prompt-modal" onClose={()=>setEditing(false)} closeDisabled={saving||recovering||!!uploadingAvatar}>
      <label className="feed-config-label" htmlFor="feed-config-name">组名称</label><input id="feed-config-name" className="feed-config-input" maxLength={40} value={groupName} onChange={e=>setGroupName(e.target.value)} disabled={saving}/>
      <FeedTemplatePicker mode={mode} people={people} profiles={data.peopleCatalog} onAvatarFile={data.capabilities.editPeopleAvatars?(id,file)=>void uploadAvatar(id,file):undefined} uploadingAvatar={uploadingAvatar} disabled={saving||recovering||!!uploadingAvatar} onMode={value=>{if(value===mode)return;setMode(value);setIntervalMinutes(value==="people"?5:360);setAutoUpdate(true);}} onPeople={setPeople}/>
      <div className="feed-update-settings"><span>自动更新</span><button type="button" role="switch" aria-label="自动更新动态" aria-checked={autoUpdate} disabled={saving} onClick={()=>setAutoUpdate(value=>!value)} className={`relative h-5 w-9 flex-none rounded-full transition-colors duration-300 ease-out ${autoUpdate?"bg-[#34c759]":"bg-[#e9e9ea] dark:bg-[#3a3a3c]"}`}><span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full shadow transition-transform duration-300 ${autoUpdate?"translate-x-4":""}`} style={{backgroundColor:"#fff",transitionTimingFunction:"cubic-bezier(.32,.72,0,1)"}}/></button></div>
      <div className="feed-update-settings"><span>更新间隔</span><AppSelect value={String(interval)} onChange={value=>setIntervalMinutes(Number(value))} options={(mode==="people"?[5,15,30,60,360,1440]:[60,180,360,720,1440]).concat(interval).filter((value,index,all)=>all.indexOf(value)===index).sort((a,b)=>a-b).map(value=>({value:String(value),label:value<60?`每 ${value} 分钟`:`每 ${value/60} 小时`}))} ariaLabel="动态更新间隔"/></div>
      {mode==="news"&&<>
      <label className="sr-only" htmlFor="feed-instructions">你的动态应该包含什么内容？</label><textarea id="feed-instructions" data-autofocus value={draft} onChange={e=>setDraft(e.target.value)} disabled={saving} maxLength={4000} placeholder="为我打造一个关于我兴趣的动态版块。关注美国大新闻、美股大事件和重要公司动向。保持内容简洁直接，保留来源，避免点击诱饵。" className="feed-instructions"/>
      <div className="feed-prompt-meta"><span>{draft.length.toLocaleString("en-US")}/4,000</span></div>
      <button type="button" className="feed-source-disclosure" aria-expanded={sourcesOpen} onClick={()=>setSourcesOpen(v=>!v)}><IconRss size={16}/><span>订阅源{subscriptions.length?` · ${subscriptions.length}`:""}</span><span>{sourcesOpen?"收起":"配置"}</span></button>
      {sourcesOpen&&<div className="feed-source-config"><p>订阅内容与自由搜索一起提炼，不会限制探索范围。</p>{subscriptions.map((source,index)=><div className="feed-source-row" key={source.url}><div><b>{source.name}</b><small>{source.url}</small></div><button type="button" aria-label={`移除${source.name}`} disabled={saving} onClick={()=>setSubscriptions(previous=>previous.filter((_,n)=>n!==index))}><IconX size={15}/></button></div>)}
        <label className="feed-config-label" htmlFor="feed-source-name">添加 RSS / Atom</label><input id="feed-source-name" className="feed-config-input" value={sourceName} onChange={e=>setSourceName(e.target.value)} maxLength={60} placeholder="订阅名称" disabled={saving||testingSource}/><input className="feed-config-input" aria-label="RSS或Atom地址" value={sourceUrl} onChange={e=>setSourceUrl(e.target.value)} maxLength={2048} placeholder="https://… /rss.xml" inputMode="url" autoComplete="off" spellCheck={false} disabled={saving||testingSource}/><button type="button" className="feed-source-add" onClick={()=>void addSource()} disabled={saving||testingSource||subscriptions.length>=8||!sourceName.trim()||!sourceUrl.trim()}>{testingSource?"正在检查":"检查并添加"}</button>{sourceResult&&<p role="status">{sourceResult}</p>}
        <div className="feed-source-recommendations"><small>可选官方订阅</small>{data.recommendations?.map(source=><button type="button" key={source.url} disabled={saving||subscriptions.some(value=>value.url===source.url)||subscriptions.length>=8} onClick={()=>setSubscriptions(previous=>[...previous,{name:source.name,url:source.url}])}><IconPlus size={13}/>{source.name}</button>)}</div>
        {!!data.observedPublishers?.length&&<p className="feed-source-observed">Muse 当前可见引用：{data.observedPublishers.join("、")}。不是完整源库；未确认有效RSS的媒体仍由自由搜索发现。</p>}
      </div>}
      {(!draft.trim()||!data.capabilities.generate)&&<p className="feed-prompt-note">{!draft.trim()?"清空指示会停止后续更新。":"指示会保存到账号；配置大模型服务后即可更新。"}</p>}
      </>}
      {promptError&&<p role="alert" className={conflict?"feed-error":"feed-prompt-note"}>{promptError}{conflict&&<button type="button" disabled={recovering} onClick={()=>void recoverDraft()}>{recovering?"正在读取":"读取最新版本，保留草稿"}</button>}</p>}
      <div className="feed-modal-actions"><button type="button" disabled={saving||recovering||!!uploadingAvatar} onClick={()=>setEditing(false)}>取消</button><button type="button" className="feed-primary" onClick={()=>void save()} disabled={saving||recovering||!!uploadingAvatar||testingSource||conflict||!groupName.trim()||!changed}>{saving?"正在保存":"保存"}</button></div>
    </AppModal>}
    {tasks&&shown&&data&&<FeedAgentPanel data={data} tab={agentTab} onTabChange={tab=>agentView(true,tab)} onClose={()=>setTasks(false)} onProfileChange={(profile:FeedAgentProfile)=>{invalidateReads();setData(current=>current?{...current,agent:profile,capabilities:{...current.capabilities,avatar:{image:profile.image||"/uploads/feature/feed/alcor.png",video:null}}}:current);void load(true);}} onRefresh={()=>void refresh()} refreshDisabled={requesting||!canRefresh}/>}

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
