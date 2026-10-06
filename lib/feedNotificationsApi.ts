import { createHash } from "node:crypto";
import { authenticateAppAccess, assertAppOrigin } from "./appAuth";
import { ok, fail } from "./api";
import { readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { FeedError, sourceUrl } from "./feedValidation";
import { feedTables, feedGroup, normalizeGeneratedPosts, appendFeedPosts, getFeedPost } from "./feedStore";
import { notificationPreferences, notificationUnread, notificationUuid, registerNotificationDevice } from "./feedNotifications";
import { FEED_ICONS, type FeedSource } from "./feedTypes";
import { rateLimit } from "./rateLimit";
class NotificationError extends FeedError{constructor(message:string,status:number,public code:number){super(message,status);}}
const object=(body:unknown):Record<string,unknown>=>{if(!body||typeof body!=="object"||Array.isArray(body))throw new FeedError("请求体无效");return body as Record<string,unknown>;};
function keys(b:Record<string,unknown>,allowed:string[]){if(Object.keys(b).some(k=>!allowed.includes(k)))throw new FeedError("不支持额外字段");}
function text(v:unknown,max:number,optional=false):string {if(typeof v!=="string"||v.length>max||(!optional&&!v.trim()))throw new FeedError("发布文字格式或长度无效");return v;}
function publicationPost(body:unknown){
 const p=object(body);keys(p,["title","icon","segments","sources"]);text(p.title,140);
 if(!FEED_ICONS.includes(p.icon as typeof FEED_ICONS[number])||!Array.isArray(p.sources)||p.sources.length<1||p.sources.length>8||!Array.isArray(p.segments)||p.segments.length<1||p.segments.length>16)throw new FeedError("正式新闻参数无效");
 const ids=new Set<string>();const sources=p.sources.map(v=>{const r=object(v);keys(r,["id","title","url","publisher","publishedAt","excerpt"]);
  const id=text(r.id,40);if(!/^[A-Za-z0-9_-]+$/.test(id)||ids.has(id))throw new FeedError("来源编号无效或重复");ids.add(id);
  const url=sourceUrl(r.url);if(!url)throw new FeedError("来源须为公开HTTPS链接");
  const at=r.publishedAt;if(at!==null&&(typeof at!=="string"||!/^\d{4}-\d\d-\d\dT/.test(at)||!Number.isFinite(Date.parse(at))))throw new FeedError("来源时间无效");
  return {id,title:text(r.title,200),url,publisher:text(r.publisher,100,true),publishedAt:at as string|null,excerpt:text(r.excerpt,1500,true)} satisfies FeedSource;
 });
 let length=0;for(const value of p.segments){const s=object(value);keys(s,["text","sourceId"]);length+=text(s.text,700).length;if(typeof s.sourceId!=="string"||!ids.has(s.sourceId))throw new FeedError("每段须引用已有来源");}if(length>2200)throw new FeedError("正文过长");
 const posts=normalizeGeneratedPosts([p],sources);if(posts.length!==1)throw new FeedError("没有有效正式正文");return posts[0];
}
export async function feedNotificationsResponse(request:Request,params:Promise<{action?:string[]}>) {
 try{
  const authenticate=()=>{try{assertAppOrigin(request);}catch{throw new FeedError("请求来源不受信任",403);}const token=request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1];const g=token?authenticateAppAccess(token,request):null;if(!g)throw new FeedError("需要有效App连接",401);if(!g.scope.split(" ").includes(request.method==="GET"?"feed.read":"feed.write"))throw new FeedError("连接缺少动态授权",403);return g;};
  const initial=authenticate(),authorize=()=>{const g=authenticate();if(g.id!==initial.id||g.user_id!==initial.user_id||g.security_stamp!==initial.security_stamp)throw new FeedError("连接已变化",401);return g;};
  const action=(await params).action??[],key=action.join("/");authorize();
  if(!rateLimit(`feed-notifications:${initial.user_id}`,180,60_000))throw new FeedError("操作过于频繁",429);
  const method=request.method,q=new URL(request.url).searchParams;
  if(key!==""&&q.size)throw new FeedError("不支持查询参数");
  const body=method==="GET"?null:object(await readJsonBody(request,32_768));authorize();
  const db=feedTables(),user=initial.user_id;
  return db.transaction(()=>{
   const grant=authorize();
   if(method==="GET"&&key===""){
    if([...q.keys()].some(k=>!["limit","before"].includes(k)||q.getAll(k).length!==1))throw new FeedError("查询参数无效");
    const raw=q.get("limit")??"20",before=q.get("before");if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>50||before!==null&&(!/^[1-9]\d*$/.test(before)||!Number.isSafeInteger(Number(before))))throw new FeedError("分页参数无效");
    const limit=Number(raw),rows=db.prepare(`SELECT seq,id,post_id AS postId,group_id AS groupId,title,created_at AS createdAt,read_at AS readAt FROM feed_notifications WHERE user_id=? ${before?"AND seq<?":""} ORDER BY seq DESC LIMIT ?`).all(user,...(before?[Number(before)]:[]),limit+1) as {seq:number;id:string;postId:string;groupId:string;title:string;createdAt:string;readAt:string|null}[];
    const page=rows.slice(0,limit);return ok({items:page.map(({seq,...r})=>r),nextCursor:rows.length>limit?String(page.at(-1)!.seq):null,unreadCount:notificationUnread(db,user)});
   }
   if(method==="GET"&&key==="preferences")return ok(notificationPreferences(db,user));
   if(method==="PUT"&&key==="preferences"){
    keys(body!,["dnd","revision"]);if(typeof body!.dnd!=="boolean"||!Number.isSafeInteger(body!.revision)||Number(body!.revision)<0)throw new FeedError("免打扰参数无效");
    const old=notificationPreferences(db,user);if(old.revision!==body!.revision)throw new NotificationError("偏好已变化，请重新读取",409,40902);
    db.prepare("INSERT INTO feed_notification_preferences VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET dnd=excluded.dnd,revision=excluded.revision,updated_at=excluded.updated_at").run(user,body!.dnd?1:0,old.revision+1,new Date().toISOString());
    if(body!.dnd)db.prepare("UPDATE feed_notification_outbox SET state='suppressed',reason='dnd' WHERE state='queued' AND notification_id IN (SELECT id FROM feed_notifications WHERE user_id=?)").run(user);
    return ok(notificationPreferences(db,user));
   }
   if(method==="PUT"&&key==="read"){
    keys(body!,["ids"]);const ids=body!.ids;if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"||!/^fn-[a-f0-9]{24}$/.test(id)))throw new FeedError("通知编号无效");
    for(const id of ids)if(!db.prepare("SELECT 1 FROM feed_notifications WHERE id=? AND user_id=?").get(id,user))throw new FeedError("通知不存在",404);
    for(const id of ids)db.prepare("UPDATE feed_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?").run(new Date().toISOString(),id,user);
    return ok({unreadCount:notificationUnread(db,user)});
   }
   if(method==="PUT"&&key==="devices"){
    if(!grant.scope.split(" ").includes("feed.read"))throw new FeedError("设备登记也需feed.read",403);
    return ok(registerNotificationDevice(db,user,grant.id,body!));
   }
   if(method==="DELETE"&&key==="devices"){
    keys(body!,["installationId"]);const id=notificationUuid(body!.installationId);db.prepare("UPDATE feed_notification_devices SET active=0 WHERE installation_id=? AND user_id=?").run(id,user);
    db.prepare("UPDATE feed_notification_outbox SET state='suppressed',reason='revoked' WHERE state='queued' AND installation_id IN(SELECT installation_id FROM feed_notification_devices WHERE installation_id=? AND user_id=?)").run(id,user);return ok({revoked:true});
   }
   if(method==="GET"&&action.length===2&&action[0]==="publications"){
    const id=notificationUuid(action[1]);const r=db.prepare("SELECT result_json FROM feed_publication_receipts WHERE user_id=? AND publication_id=?").get(user,id) as {result_json:string}|undefined;if(!r)throw new FeedError("提交回执不存在",404);return ok(JSON.parse(r.result_json));
   }
   if(method==="POST"&&key==="publications"){
    keys(body!,["publicationId","groupId","post"]);const id=notificationUuid(body!.publicationId);
    if(db.prepare("SELECT 1 FROM feed_publication_receipts WHERE user_id=? AND publication_id=?").get(user,id))throw new NotificationError("发布编号已使用，请查询原回执",409,40901);
    if(typeof body!.groupId!=="string"||feedGroup(user,body!.groupId).mode!=="news")throw new FeedError("须为本人的新闻动态组");
    const post=publicationPost(body!.post),group=body!.groupId;
    const added=appendFeedPosts(user,[post],group),fingerprint=createHash("sha256").update((group==="default"?"":group+"\n")+post.sources.map(s=>s.url).sort().join("\n")).digest("hex");
    const row=db.prepare("SELECT id FROM feed_posts WHERE user_id=? AND fingerprint=?").get(user,fingerprint) as {id:string};
    const receipt={publicationId:id,postId:row.id,groupId:group,state:"published",created:added===1,createdAt:getFeedPost(user,row.id).createdAt};
    db.prepare("INSERT INTO feed_publication_receipts VALUES(?,?,?)").run(user,id,JSON.stringify(receipt));return ok(receipt);
   }
   throw new FeedError("通知接口或方法不存在",404);
  }).immediate();
 }catch(e){const status=e instanceof FeedError?e.status:e instanceof RequestBodyTooLargeError?413:500;return fail(e instanceof NotificationError?e.code:status*100+1,e instanceof FeedError?e.message:status===413?"请求过长":"通知服务暂不可用",status);}
}
