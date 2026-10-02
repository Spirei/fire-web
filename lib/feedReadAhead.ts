import { feedRequest } from "./feedClient";
import { FEED_PAGE_SIZE, type FeedPayload } from "./feedTypes";

type Entry = { controller:AbortController; promise:Promise<FeedPayload>; payload?:FeedPayload; expires:number };

/** Small, page-local read-ahead cache. Preloading never marks a person as seen. */
export class FeedReadAhead {
  private entries=new Map<string,Entry>();
  constructor(private request:typeof feedRequest=feedRequest){}
  private key(group:string,author:string){return `${group}:${author}`;}
  private get(group:string,author:string){
    const key=this.key(group,author),entry=this.entries.get(key);
    if(entry&&entry.expires>Date.now()&&!entry.controller.signal.aborted)return entry;
    entry?.controller.abort();this.entries.delete(key);
  }
  peek(group:string,author:string){return this.get(group,author)?.payload||null;}
  async preload(group:string,author="") {
    if(this.get(group,author))return;
    const key=this.key(group,author),controller=new AbortController();
    const entry:Entry={controller,expires:Date.now()+20_000,promise:this.request<FeedPayload>(this.path(group,author,FEED_PAGE_SIZE),"GET",undefined,controller.signal)};
    this.entries.set(key,entry);
    while(this.entries.size>8){const oldest=this.entries.keys().next().value!;this.entries.get(oldest)?.controller.abort();this.entries.delete(oldest);}
    try{const payload=await entry.promise;if(this.entries.get(key)===entry&&!controller.signal.aborted)entry.payload=payload;}
    catch{if(this.entries.get(key)===entry)this.entries.delete(key);}
  }
  async read(group:string,author:string,limit:number,signal:AbortSignal) {
    const entry=this.get(group,author);
    if(!entry)return this.request<FeedPayload>(this.path(group,author,limit),"GET",undefined,signal);
    this.entries.delete(this.key(group,author));
    if(signal.aborted){entry.controller.abort();throw signal.reason||new DOMException("Aborted","AbortError");}
    const payload=await new Promise<FeedPayload>((resolve,reject)=>{
      const abort=()=>{entry.controller.abort();reject(signal.reason||new DOMException("Aborted","AbortError"));};
      signal.addEventListener("abort",abort,{once:true});
      void entry.promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
    });
    // Pagination must not extend the response used to seed the visible view.
    return {...payload,posts:[...payload.posts]};
  }
  invalidate(group?:string){for(const [key,entry] of this.entries)if(!group||key.startsWith(`${group}:`)){entry.controller.abort();this.entries.delete(key);}}
  private path(group:string,author:string,limit:number){return `?limit=${limit}&group=${encodeURIComponent(group)}${author?`&author=${encodeURIComponent(author)}`:""}`;}
}
