"use client";
import SafeAssetImage from "./SafeAssetImage";

/** Fixed square geometry for both images and initials, including flex-row cards. */
export default function Avatar({ src, name, size = 32, className = "" }: {src?:string|null;name:string;size?:number;className?:string}) {
  return <span className={`app-avatar ${className}`} style={{display:"inline-grid",placeItems:"center",flex:`0 0 ${size}px`,width:size,height:size,minWidth:size,maxWidth:size,minHeight:size,maxHeight:size,aspectRatio:"1",borderRadius:"50%",overflow:"hidden"}}>
    {/* Keep the circle empty while the image loads; showing the initial first
        makes a refresh look like the avatar changed back to a letter. */}
    <SafeAssetImage src={src||undefined} alt={name} showFallbackWhileLoading={false} style={{display:"block",width:"100%",height:"100%",objectFit:"cover"}} fallback={<span aria-hidden="true">{name.trim().slice(0,1).toUpperCase()||"?"}</span>}/>
  </span>;
}
