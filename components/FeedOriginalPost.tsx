"use client";

import { memo,useState } from "react";
import { IconDots, IconHeart, IconMessageCircle, IconArrowUpRight } from "@tabler/icons-react";
import type { FeedPost } from "@/lib/feedTypes";
import SafeAssetImage from "./SafeAssetImage";
import FeedMedia from "./FeedMedia";
import FeedPersonBadge from "./FeedPersonBadge";

const timeFormat=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
const fullTimeFormat=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
function originalTime(value:string|null,full=false) {
  const date=new Date(value||"");
  return Number.isFinite(date.getTime())?(full?fullTimeFormat:timeFormat).format(date):"时间未知";
}
export default memo(function FeedOriginalPost({post,isNew,busy,canDiscuss,onMenu,onLike,onDiscuss}:{post:FeedPost;isNew:boolean;busy:boolean;canDiscuss:boolean;onMenu:(post:FeedPost)=>void;onLike:(post:FeedPost)=>void;onDiscuss:(post:FeedPost)=>void}) {
  const [showOriginal,setShowOriginal]=useState(false);
  const original=post.original!;
  const text=showOriginal?original.text:original.textZh||original.text;
  return <article className="feed-post feed-original" aria-label={`${original.person.name}的原帖`}>
    <SafeAssetImage src={original.person.avatar} alt={original.person.name} loading="lazy" className="feed-person-avatar" fallback={<span className="feed-person-avatar feed-person-avatar-fallback">{original.person.name.slice(0,1)}</span>}/>
    <div className="feed-post-content">
      <div className="feed-original-heading">
        <div className="feed-original-identity">{isNew&&<span className="feed-unread-dot" aria-label="新动态"/>}<strong className="feed-person-name">{original.person.name}<FeedPersonBadge personId={original.person.id}/></strong><span className="feed-original-handle">{original.person.handle}</span><time dateTime={post.publishedAt||undefined} title={`${originalTime(post.publishedAt,true)}（北京时间）`}>{originalTime(post.publishedAt)}</time></div>
        <button type="button" className="feed-more" aria-label={`${original.person.name}原帖的选项`} onClick={()=>onMenu(post)}><IconDots size={17}/></button>
      </div>
      {original.replyTo&&<p className="feed-original-context">回复 @{original.replyTo}</p>}
      {text&&<p className="feed-body">{text}</p>}
      {!!post.media.length&&<div className="feed-original-media"><FeedMedia media={post.media} limit={Infinity}/></div>}
      {original.quote&&<blockquote className="feed-original-quote"><strong>{original.quote.name}</strong>{original.quote.text&&<p className="feed-body">{original.quote.text}</p>}{!!original.quote.media.length&&<div className="feed-original-media"><FeedMedia media={original.quote.media} limit={Infinity}/></div>}{original.quote.url&&<a className="feed-inline-action" href={original.quote.url} target="_blank" rel="noopener noreferrer">查看转发原帖 <IconArrowUpRight size={14}/></a>}</blockquote>}
      {original.textZh&&<div className="feed-original-links"><button type="button" data-capsule="off" onClick={()=>setShowOriginal(value=>!value)} aria-pressed={showOriginal}>{showOriginal?"中文译文":"原文"}</button></div>}
      <div className="feed-post-actions"><button type="button" aria-label={post.liked?"取消喜欢":"喜欢"} aria-pressed={post.liked} disabled={busy} onClick={()=>onLike(post)} className={post.liked?"is-liked":""}><IconHeart size={21} stroke={1.8} fill={post.liked?"currentColor":"none"}/></button><button type="button" onClick={()=>onDiscuss(post)} disabled={!canDiscuss} title={canDiscuss?"与 Alcor 讨论这条原帖":"配置大模型服务后可讨论"}><IconMessageCircle size={21} stroke={1.8}/><span>讨论</span></button></div>
    </div>
  </article>;
});
