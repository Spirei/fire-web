"use client";

import { useEffect,useRef,useState } from "react";
import { IconUserCircle } from "@tabler/icons-react";
import SafeAssetImage from "./SafeAssetImage";

/** The local default loop shares the still image's crop and never covers it before playback. */
export default function FeedAgentPortrait({image,video,name}:{image:string;video:string|null;name:string}) {
  const [reduced,setReduced]=useState(true),[playback,setPlayback]=useState({src:video,ready:false,failed:false});
  const element=useRef<HTMLVideoElement>(null),inView=useRef(true);
  if(playback.src!==video)setPlayback({src:video,ready:false,failed:false});
  const failed=playback.src===video&&playback.failed,ready=playback.src===video&&playback.ready;
  useEffect(()=>{
    const media=matchMedia("(prefers-reduced-motion: reduce)"),sync=()=>setReduced(media.matches);
    sync();media.addEventListener("change",sync);return()=>media.removeEventListener("change",sync);
  },[]);
  useEffect(()=>{
    const player=element.current;if(!player)return;
    const sync=()=>{if(document.hidden||reduced||!inView.current)player.pause();else void player.play().catch(()=>undefined);};
    const observer=typeof IntersectionObserver!=="undefined"?new IntersectionObserver(entries=>{inView.current=entries[0]?.isIntersecting??true;sync();}):null;
    observer?.observe(player);document.addEventListener("visibilitychange",sync);sync();
    return()=>{observer?.disconnect();document.removeEventListener("visibilitychange",sync);player.pause();};
  },[video,reduced,failed]);
  return <>
    <SafeAssetImage src={image} className="feed-agent-face-image" style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} showFallbackWhileLoading={false} alt={name} fallback={<IconUserCircle size={88} stroke={1}/>}/>
    {video&&!reduced&&!failed&&<video key={video} ref={element} className="feed-agent-face-image feed-agent-face-video" src={video} width={116} height={116} muted loop playsInline preload="metadata" aria-hidden="true" style={{opacity:ready?1:0}} onPlaying={()=>setPlayback(current=>current.src===video?{...current,ready:true}:current)} onError={()=>setPlayback(current=>current.src===video?{...current,failed:true}:current)}/>}
  </>;
}
