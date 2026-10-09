"use client";
import { useEffect,useRef,useState } from "react";
import { IconPlayerPlay } from "@tabler/icons-react";
import AppModal from "./AppModal";
import { observePanelVisibility,panelIsShown } from "@/lib/panelVisibility";
import type { FeedMedia as Media } from "@/lib/feedTypes";

function Item({media,onPreview}:{media:Media;onPreview:(media:Media)=>void}) {
  const [failed,setFailed]=useState(false),root=useRef<HTMLDivElement>(null);
  useEffect(()=>{const sync=()=>{if(document.hidden||!panelIsShown(root.current))root.current?.querySelector("video")?.pause();};const release=root.current?observePanelVisibility(root.current,sync):()=>{};document.addEventListener("visibilitychange",sync);return()=>{release();document.removeEventListener("visibilitychange",sync);};},[]);
  if(failed)return null;
  return <div ref={root} className={`feed-media-item is-${media.type}`}>
    {media.type==="image"?<button type="button" onClick={()=>onPreview(media)} aria-label={`预览${media.alt}`}><img src={media.url} alt={media.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/></button>:
      media.playback==="external"?<a href={media.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label="在来源网站播放视频">{media.poster&&<img src={media.poster} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.style.display="none";}}/>}<span><IconPlayerPlay size={22}/>播放报道视频</span></a>:
      <video src={media.url} poster={media.poster} controls playsInline preload="none" aria-label={media.alt} onError={()=>setFailed(true)}/>}
  </div>;
}
export default function FeedMedia({media,limit=3}:{media:Media[];limit?:number}) {
  const [preview,setPreview]=useState<Media|null>(null);
  return <><div className="feed-media">{media.slice(0,limit).map(m=><Item key={m.url} media={m} onPreview={setPreview}/>)}</div>{preview&&<AppModal title={preview.alt||"报道图片"} size="lg" className="feed-theme feed-themed-modal feed-media-modal" onClose={()=>setPreview(null)}><img className="feed-media-preview" src={preview.url} alt={preview.alt} referrerPolicy="no-referrer"/></AppModal>}</>;
}
