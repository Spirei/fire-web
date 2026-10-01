import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { FEED_PEOPLE } from "./feedPeopleConfig";
import { getCelebAvatars } from "./celebsData";
import type { FeedGroup, FeedPost } from "./feedTypes";
import { feedId, feedTables, sourceUrl } from "./feedStore";
import { readTradingSquareSnapshot } from "./tradingSquareSnapshot";
import { isLocalPostImageUrl } from "./tradingSquareImages";
import { getTradingSquareSourceStatus, refreshDuanPosts, refreshTrumpPosts, readTrumpPosts, isTrumpRefreshing, isDuanRefreshing } from "./tradingSquareRefresh";
import { backfillTrumpTranslations } from "./tradingSquareTranslate";
import type { FeedPersonId } from "./feedTypes";

const imported = new WeakMap<object,Map<string,string>>();
function cacheSignature() {
  return ["data/trump-posts.json","data/duan-posts.json","data/trump-translations.json","data/celebs-avatars.json","public/uploads/celebs/default-avatars.json","public/uploads/trading-square/trump","public/uploads/trading-square/duan"].map(name=>{
    try{const stat=fs.statSync(path.join(process.cwd(),name));return `${stat.mtimeMs}:${stat.size}`;}catch{return "missing";}
  }).join("/");
}
function availableImage(url:string) {
  return isLocalPostImageUrl(url)&&fs.existsSync(path.join(process.cwd(),"public",url));
}
export function feedPeopleProfiles() {
  const avatars=getCelebAvatars();
  return FEED_PEOPLE.map(person=>({...person,avatar:avatars[person.id]||person.avatar}));
}
export function feedPeopleLatestAt(userId:string,group:FeedGroup) {
  const rows=feedTables().prepare("SELECT author_key,MAX(sort_at) AS latest FROM feed_posts WHERE user_id=? AND group_id=? AND kind='people' AND hidden=0 GROUP BY author_key").all(userId,group.id) as {author_key:string;latest:string}[];
  return Object.fromEntries((group.people||[]).map(id=>[id,rows.find(row=>row.author_key===id)?.latest||null]));
}
/** Source identity stays outside the model. Later translations update payload only, never likes or hidden state. */
export function syncPeopleFeed(userId:string,group:FeedGroup) {
  const db=feedTables(),key=`${userId}:${group.id}`,signature=`${group.revision}:${cacheSignature()}`;
  const memo=imported.get(db)||new Map<string,string>();imported.set(db,memo);
  if(memo.get(key)===signature)return 0;
  const profiles=feedPeopleProfiles();
  const posts=readTradingSquareSnapshot(Infinity).filter(post=>group.people?.includes(post.author));
  const added=db.transaction(()=>{
    let count=0;
    const find=db.prepare("SELECT id,payload FROM feed_posts WHERE user_id=? AND group_id=? AND fingerprint=?");
    const insert=db.prepare("INSERT INTO feed_posts(id,user_id,group_id,fingerprint,payload,created_at,kind,sort_at,author_key) VALUES(?,?,?,?,?,?,'people',?,?)");
    const update=db.prepare("UPDATE feed_posts SET payload=?,sort_at=? WHERE id=? AND user_id=?");
    for(const raw of posts) {
      const person=profiles.find(person=>person.id===raw.author)!,url=sourceUrl(raw.originalUrl),time=Date.parse(raw.date);
      if(!url||!raw.id||!Number.isFinite(time)||time>Date.now()+60_000)continue;
      const publishedAt=new Date(time).toISOString();
      const media=(raw.images||[]).filter(availableImage).map(url=>({type:"image" as const,url,alt:`${person.name}的原帖图片`}));
      const quote=raw.quote?{name:raw.quote.name,text:raw.quote.text,...(sourceUrl(raw.quote.url)?{url:sourceUrl(raw.quote.url)!}:{}),media:(raw.quote.images||[]).filter(availableImage).map(url=>({type:"image" as const,url,alt:"转发原帖图片"}))}:undefined;
      const mediaUnavailable=(raw.images?.length||0)>media.length||(raw.quote?.images?.length||0)>(quote?.media.length||0);
      if(!raw.text.trim()&&!media.length&&!quote?.text&&!quote?.media.length&&!mediaUnavailable)continue;
      const post:Omit<FeedPost,"id"|"createdAt"|"liked"|"hidden">={
        title:`${person.name}：${(raw.textZh||raw.text).replace(/\s+/g," ").slice(0,70)||"图片动态"}`,icon:"conversation",
        segments:raw.text?[{text:raw.textZh||raw.text,sourceId:"original"}]:[],media,publishedAt,
        sources:[{id:"original",title:`${person.name}的原帖`,url,publisher:person.platform,publishedAt,excerpt:raw.text+(quote?`\n转发 ${quote.name}：${quote.text}`:"")}],
        original:{person,platformPostId:raw.id,text:raw.text,...(raw.textZh?{textZh:raw.textZh}:{}),originalUrl:url,...(raw.replyTo?{replyTo:raw.replyTo}:{}),...(quote?{quote}:{}),...(mediaUnavailable?{mediaUnavailable:true}:{})}
      };
      const fingerprint=createHash("sha256").update(`people\n${group.id}\n${person.id}\n${raw.id}`).digest("hex"),payload=JSON.stringify(post);
      const saved=find.get(userId,group.id,fingerprint) as {id:string;payload:string}|undefined;
      if(saved){if(saved.payload!==payload)update.run(payload,publishedAt,saved.id,userId);}
      else count+=insert.run(feedId(),userId,group.id,fingerprint,payload,new Date().toISOString(),publishedAt,person.id).changes;
    }
    return count;
  }).immediate();
  memo.set(key,signature);
  return added;
}
const refreshing = new Map<FeedPersonId,Promise<unknown>>();
export async function refreshPeopleFeed(group:FeedGroup) {
  await Promise.all((group.people||[]).map(id=>{
    const pending=refreshing.get(id);if(pending)return pending;
    const status=getTradingSquareSourceStatus([id])[0];
    if(status.lastAttemptAt&&Date.now()-Date.parse(status.lastAttemptAt)<60_000)return Promise.resolve();
    const task=(async()=>{
      const isRunning=id==="trump"?isTrumpRefreshing:isDuanRefreshing;
      if(isRunning()) {
        const deadline=Date.now()+180_000;
        while(isRunning()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
        return;
      }
      return id==="trump"?refreshTrumpPosts({translateBeforeSave:false,maxPages:5}):refreshDuanPosts({includeComments:false,maxPages:3});
    })().finally(()=>refreshing.delete(id));
    refreshing.set(id,task);return task;
  }));
  const statuses=getTradingSquareSourceStatus(group.people||[]);
  // Ingest original posts before any translation work finishes.
  if(group.people?.includes("trump"))void backfillTrumpTranslations(readTrumpPosts(),20);
  return statuses;
}
