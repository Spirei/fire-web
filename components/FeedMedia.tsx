"use client";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { IconPlayerPlay,IconX } from "@tabler/icons-react";
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
  // 照片预览为整屏灯箱：仅展示照片本身，不显示说明文字与卡片背景。
  useEffect(()=>{
    if(!preview)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")setPreview(null);};
    window.addEventListener("keydown",onKey);
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    return()=>{window.removeEventListener("keydown",onKey);document.body.style.overflow=previousOverflow;};
  },[preview]);
  return <><div className="feed-media">{media.slice(0,limit).map(m=><Item key={m.url} media={m} onPreview={setPreview}/>)}</div>{preview&&createPortal(
    <div className="feed-media-lightbox" role="dialog" aria-modal="true" aria-label="照片预览" onMouseDown={event=>{if(event.target===event.currentTarget)setPreview(null);}}>
      <img className="feed-media-preview" src={preview.url} alt={preview.alt} referrerPolicy="no-referrer"/>
      <button type="button" className="feed-media-lightbox-close" onClick={()=>setPreview(null)} aria-label="关闭照片预览"><IconX size={20}/></button>
    </div>,
    document.body
  )}</>;
}
