import type { FeedPayload } from "./feedTypes";
import { FeedReadAhead } from "./feedReadAhead";
import { feedRequest } from "./feedClient";

/** Confirmed snapshots and intent reads share one group-scoped invalidation owner. */
export class FeedTimelineCache {
  private snapshots=new Map<string,{revision:number;byAuthor:Map<string,FeedPayload>}>();
  private ahead:FeedReadAhead;
  constructor(request:typeof feedRequest=feedRequest,private seed:FeedPayload|null=null){this.ahead=new FeedReadAhead(request);}
  initial(group:string,author:string,revision?:number){
    return !author&&this.seed&&(this.seed.group?.id||"default")===group&&(revision===undefined||this.seed.preferences.revision===revision)?this.seed:null;
  }
  restore(group:string,author:string,revision?:number){
    const value=this.snapshots.get(group)?.byAuthor.get(author)||this.ahead.peek(group,author);
    return value&&(revision===undefined||value.preferences.revision===revision)?value:null;
  }
  remember(group:string,author:string,payload:FeedPayload){
    if((this.seed?.group?.id||"default")===group)this.seed=null;
    const previous=this.snapshots.get(group),entry=previous?.revision===payload.preferences.revision?previous:{revision:payload.preferences.revision,byAuthor:new Map<string,FeedPayload>()};
    const prior=entry.byAuthor.get(author);
    if(prior&&prior.posts!==payload.posts)entry.byAuthor.clear();
    entry.byAuthor.set(author,payload);this.snapshots.delete(group);this.snapshots.set(group,entry);
    while(this.snapshots.size>8)this.snapshots.delete(this.snapshots.keys().next().value!);
    // Translation/new posts can change without a preference revision; old intent reads still expire.
    if(previous&&(previous.revision!==payload.preferences.revision||(prior&&prior.posts!==payload.posts)))this.ahead.invalidate(group);
  }
  preload(group:string,author=""){return this.ahead.preload(group,author);}
  read(group:string,author:string,limit:number,signal:AbortSignal){return this.ahead.read(group,author,limit,signal);}
  invalidate(group:string){this.snapshots.delete(group);this.ahead.invalidate(group);if((this.seed?.group?.id||"default")===group)this.seed=null;}
  pause(){this.ahead.invalidate();}
}
