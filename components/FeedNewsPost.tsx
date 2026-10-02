"use client";

import { memo } from "react";
import { IconDots,IconHeart,IconMessageCircle } from "@tabler/icons-react";
import type { FeedPost } from "@/lib/feedTypes";
import { feedBodyParts } from "@/lib/feedPresentation";
import SafeAssetImage from "./SafeAssetImage";
import FeedMedia from "./FeedMedia";

function relative(value:string,now:number) {const n=Math.max(0,now-Date.parse(value));return n<60_000?"刚刚":n<3600_000?`${Math.floor(n/60_000)}分钟前`:n<86400_000?`${Math.floor(n/3600_000)}小时前`:`${Math.floor(n/86400_000)}天前`;}
function dateText(value:string|null) {return value?value.slice(0,10).replaceAll("-","/"):"日期未提供";}

export default memo(function FeedNewsPost({post,now,busy,canDiscuss,onMenu,onLike,onDiscuss}:{post:FeedPost;now:number;busy:boolean;canDiscuss:boolean;onMenu:(post:FeedPost)=>void;onLike:(post:FeedPost)=>void;onDiscuss:(post:FeedPost)=>void}) {
  return <article className="feed-post" aria-labelledby={`feed-title-${post.id}`}>
    <SafeAssetImage src={`/uploads/feature/feed/${post.icon}.webp`} alt="" loading="lazy" className="feed-post-icon" fallback={<span className="feed-icon-fallback">✦</span>}/>
    <div className="feed-post-content">
      <div className="feed-post-heading"><h2 id={`feed-title-${post.id}`}>{post.title}</h2><time dateTime={post.createdAt} title={post.createdAt}>{relative(post.createdAt,now)}</time><button type="button" className="feed-more" aria-label={`${post.title}的选项`} onClick={()=>onMenu(post)}><IconDots size={17}/></button></div>
      <p className="feed-body">{feedBodyParts(post.segments,post.sources).map((part,i)=>{const source=post.sources.find(s=>s.id===part.sourceId);return source?<a key={i} href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.publisher} · ${dateText(source.publishedAt)}`}>{part.text}</a>:<span key={i}>{part.text}</span>;})}</p>
      {post.media.length>0&&<FeedMedia media={post.media}/>}
      <div className="feed-post-actions"><button type="button" aria-label={post.liked?"取消喜欢":"喜欢"} aria-pressed={post.liked} disabled={busy} onClick={()=>onLike(post)} className={post.liked?"is-liked":""}><IconHeart size={21} stroke={1.8} fill={post.liked?"currentColor":"none"}/></button><button type="button" onClick={()=>onDiscuss(post)} disabled={!canDiscuss} title={canDiscuss?"与 Alcor 讨论这条动态":"配置大模型服务后可讨论"}><IconMessageCircle size={21} stroke={1.8}/><span>讨论</span></button></div>
    </div>
  </article>;
});
