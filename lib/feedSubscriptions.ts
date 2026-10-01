import { SaxesParser } from "saxes";
import { FeedError, sourceUrl } from "./feedValidation";
import { fetchPublicFeedDocument, publicFeedUrl } from "./feedPublicFetch";
import type { FeedSource, FeedSubscription, FeedMedia } from "./feedTypes";

export const FEED_RECOMMENDATIONS = [
  {name:"NPR 综合新闻",url:"https://feeds.npr.org/1001/rss.xml",note:"Muse 可见报道引用了 NPR；此为 NPR 官方新闻订阅。"},
  {name:"SEC 官方公告",url:"https://www.sec.gov/news/pressreleases.rss",note:"监管与公司披露的补充来源；部分网络可能限制访问。"}
];
export const MUSE_OBSERVED_PUBLISHERS = ["Micron 投资者关系", "Reuters", "Morningstar / Dow Jones", "NPR", "USA Today", "CNN", "Seoul Economic Daily", "New York Post", "Zacks", "The Hindu BusinessLine"];
export function normalizeFeedSubscriptions(value:unknown):FeedSubscription[] {
  if(!Array.isArray(value)||value.length>8)throw new FeedError("每组最多8个订阅源");
  const seen=new Set<string>();
  return value.map(row=>{
    if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).some(k=>!["name","url"].includes(k))||typeof row.name!=="string"||!row.name.trim()||row.name.trim().length>60)throw new FeedError("订阅源需要名称（最多60字）和公开HTTPS地址");
    const url=publicFeedUrl(row.url);if(!url||seen.has(url))throw new FeedError("订阅源地址无效或重复：只接受公开HTTPS RSS/Atom，不支持内网、凭据或非标准端口");
    seen.add(url);return {name:row.name.trim(),url};
  });
}
export function parseSubscriptionFeed(xml:string,baseUrl:string,name=""): {title:string;sources:FeedSource[]} {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||xml.length>1_500_000)throw new FeedError("订阅源格式无效",502);
  const parser=new SaxesParser(),stack:string[]=[],rows:Array<Record<string,string>&{media:FeedMedia[]}>=[];
  let root="",title="",row:Record<string,string>&{media:FeedMedia[]}|null=null,depth=0;
  const clean=(s:string)=>s.replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
  const resolve=(s:string)=>{try{return sourceUrl(new URL(s,baseUrl).href);}catch{return null;}};
  const addMedia=(tag:{attributes:Record<string,string>},type:"image"|"video",raw:string)=>{const url=resolve(raw);if(row&&url&&row.media.length<3)row.media.push({type,url,alt:"报道媒体"});};
  parser.on("opentag",tag=>{
    const local=tag.name.split(":").at(-1)!;if(!stack.length)root=local;stack.push(local);
    if(["item","entry"].includes(local)){row={media:[]} as unknown as typeof row;depth=stack.length;}
    if(!row)return;const a=tag.attributes as Record<string,string>;
    if(local==="link"&&a.href&&(!a.rel||a.rel==="alternate"))row.link=a.href;
    if(local==="enclosure"||(local==="content"&&a.url)) {if(a.type?.startsWith("image/"))addMedia(tag,"image",a.url);else if(a.type?.startsWith("video/")&&/\.(mp4|webm)(\?|$)/i.test(a.url||""))addMedia(tag,"video",a.url);}
    if(local==="thumbnail"&&a.url)addMedia(tag,"image",a.url);
  });
  const text=(value:string)=>{
    const local=stack.at(-1);
    if(!row){if(local==="title"&&stack.length<=3)title+=value;return;}
    for(const field of ["title","link","pubDate","published","description","summary","encoded","content"]){
      if(stack.slice(depth).includes(field))row[field]=(row[field]||"")+value;
    }
  };
  parser.on("text",text);parser.on("cdata",text);
  parser.on("closetag",tag=>{if(row&&stack.length===depth&&["item","entry"].includes(tag.name.split(":").at(-1)!)){if(rows.length<50)rows.push(row);row=null;}stack.pop();});
  try{parser.write(xml).close();}catch{throw new FeedError("不是有效的RSS/Atom订阅",502);}
  if(!["rss","feed","RDF"].includes(root))throw new FeedError("请输入RSS/Atom地址，不是网页地址",502);
  const sources=rows.flatMap((r,i)=>{
    const url=r.link?resolve(r.link):null,headline=clean(r.title||"").slice(0,300);if(!url||!headline)return [];
    const t=Date.parse(r.pubDate||r.published||"");
    return [{id:`r${i}`,title:headline,url,publisher:(name||clean(title)||new URL(baseUrl).hostname).slice(0,100),publishedAt:Number.isFinite(t)&&t<=Date.now()+60_000?new Date(t).toISOString():null,excerpt:clean(r.encoded||r.content||r.description||r.summary||"").slice(0,16000),media:r.media}];
  });
  return {title:clean(title).slice(0,100)||name,sources};
}
export async function readFeedSubscription(source:FeedSubscription) {
  const doc=await fetchPublicFeedDocument(source.url);return parseSubscriptionFeed(doc.text,doc.url,source.name);
}
export async function subscriptionSources(sources:FeedSubscription[]):Promise<{sources:FeedSource[];unavailable:string[]}> {
  const results=[];
  for(let i=0;i<sources.length;i+=3)results.push(...await Promise.all(sources.slice(i,i+3).map(async s=>{try{return {sources:(await readFeedSubscription(s)).sources,unavailable:[]};}catch{return {sources:[],unavailable:[s.name]};}})));
  return {sources:results.flatMap(r=>r.sources).filter(s=>!s.publishedAt||Date.now()-Date.parse(s.publishedAt)<7*86400_000),unavailable:results.flatMap(r=>r.unavailable)};
}
