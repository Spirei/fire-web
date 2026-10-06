import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { notificationGrant } from "./appAuth";
import { apnsConfiguration, apnsPayload, sendApns } from "./apns";
import { FeedError } from "./feedValidation";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function notificationUuid(value:unknown):string {if(typeof value!=="string"||!uuid.test(value))throw new FeedError("编号应为小写UUID");return value;}
export function notificationPreferences(db:Database.Database,userId:string) {
 const row=db.prepare("SELECT dnd,revision,updated_at FROM feed_notification_preferences WHERE user_id=?").get(userId) as {dnd:number;revision:number;updated_at:string|null}|undefined;
 return {dnd:!!row?.dnd,revision:row?.revision??0,updatedAt:row?.updated_at??null};
}
export function notificationUnread(db:Database.Database,userId:string) {return (db.prepare("SELECT COUNT(*) n FROM feed_notifications WHERE user_id=? AND read_at IS NULL").get(userId) as {n:number}).n;}
export function enqueueFeedNotification(db:Database.Database,userId:string,postId:string) {
 if(!apnsConfiguration().ready||notificationPreferences(db,userId).dnd)return;
 const n=db.prepare("SELECT id FROM feed_notifications WHERE user_id=? AND post_id=?").get(userId,postId) as {id:string}|undefined;if(!n)return;
 const devices=db.prepare("SELECT installation_id,grant_id,revision FROM feed_notification_devices WHERE user_id=? AND active=1 AND topic=?").all(userId,apnsConfiguration().topic) as {installation_id:string;grant_id:string;revision:number}[];
 for(const d of devices)if(notificationGrant(d.grant_id)?.user_id===userId)db.prepare("INSERT OR IGNORE INTO feed_notification_outbox VALUES(?,?,?,?,?,?,NULL,NULL)").run(randomUUID(),n.id,d.installation_id,d.revision,"queued",new Date().toISOString());
}
export function registerNotificationDevice(db:Database.Database,userId:string,grantId:string,body:Record<string,unknown>) {
 if(Object.keys(body).some(k=>!["installationId","deviceToken","environment"].includes(k)))throw new FeedError("设备参数无效");
 const id=notificationUuid(body.installationId),token=body.deviceToken,environment=body.environment;
 if(typeof token!=="string"||!/^[a-f0-9]{16,512}$/.test(token)||token.length%2||typeof environment!=="string"||!["sandbox","production"].includes(String(environment)))throw new FeedError("设备Token或环境无效");
 const cfg=apnsConfiguration();if(!cfg.ready||!cfg.environments.includes(String(environment)))throw new FeedError("服务器尚未配置此环境的APNs",503);
 const old=db.prepare("SELECT * FROM feed_notification_devices WHERE installation_id=? OR (environment=? AND token=?)").all(id,environment,token) as {installation_id:string;user_id:string;grant_id:string;revision:number;active:number;token:string;environment:string;topic:string}[];
 if(old.some(d=>d.user_id!==userId&&d.active&&notificationGrant(d.grant_id)))throw new FeedError("设备仍绑定另一有效连接，请先解绑",409);
 if(old.some(d=>d.installation_id!==id&&d.user_id===userId&&d.active&&notificationGrant(d.grant_id)))throw new FeedError("Token仍绑定另一安装，请先解绑",409);
 const current=old.find(d=>d.installation_id===id),count=(db.prepare("SELECT COUNT(*) n FROM feed_notification_devices WHERE user_id=? AND active=1 AND installation_id<>?").get(userId,id) as {n:number}).n;
 if(current?.user_id===userId&&current.active&&current.grant_id===grantId&&current.token===token&&current.environment===environment&&current.topic===cfg.topic)return {installationId:id,environment,registered:true};
 if(count>=16)throw new FeedError("有效设备已达上限",429);
 for(const d of old){db.prepare("UPDATE feed_notification_outbox SET state='suppressed',reason='device_replaced' WHERE installation_id=? AND state='queued'").run(d.installation_id);if(d.installation_id!==id)db.prepare("DELETE FROM feed_notification_devices WHERE installation_id=?").run(d.installation_id);}
 db.prepare("INSERT INTO feed_notification_devices VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(installation_id) DO UPDATE SET user_id=excluded.user_id,grant_id=excluded.grant_id,token=excluded.token,environment=excluded.environment,topic=excluded.topic,revision=excluded.revision,active=1,updated_at=excluded.updated_at").run(id,userId,grantId,token,environment,cfg.topic,(current?.revision??0)+1,new Date().toISOString());
 return {installationId:id,environment,registered:true};
}
type Delivery={id:string;notification_id:string;installation_id:string;device_revision:number;user_id:string;post_id:string;group_id:string;grant_id:string;token:string;environment:"sandbox"|"production"};
export async function drainFeedNotifications(sender=sendApns) {
 const db=getDb();if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='feed_notification_outbox'").get())return;
 // Claimed rows are intentionally never retried after an ambiguous response/restart.
 for(let i=0;i<50;i++){
  const d=db.transaction(()=>{const row=db.prepare(`SELECT o.*,n.user_id,n.post_id,n.group_id,d.grant_id,d.token,d.environment FROM feed_notification_outbox o JOIN feed_notifications n ON n.id=o.notification_id JOIN feed_notification_devices d ON d.installation_id=o.installation_id WHERE o.state='queued' ORDER BY o.created_at,o.id LIMIT 1`).get() as Delivery|undefined;if(row)db.prepare("UPDATE feed_notification_outbox SET state='claimed' WHERE id=? AND state='queued'").run(row.id);return row;}).immediate();if(!d)return;
  const guard=()=>{const device=db.prepare("SELECT user_id,revision,active,topic FROM feed_notification_devices WHERE installation_id=?").get(d.installation_id) as {user_id:string;revision:number;active:number;topic:string}|undefined;
   const post=db.prepare("SELECT hidden FROM feed_posts WHERE id=? AND user_id=?").get(d.post_id,d.user_id) as {hidden:number}|undefined;
   return !!device&&device.user_id===d.user_id&&device.active===1&&device.topic===apnsConfiguration().topic&&device.revision===d.device_revision&&post?.hidden===0&&!notificationPreferences(db,d.user_id).dnd&&notificationGrant(d.grant_id)?.user_id===d.user_id;
  };
  let result:{status:number;reason:string}={status:0,reason:"suppressed"};
  if(guard())try{result=await sender(d.environment,d.token,d.id,apnsPayload({id:d.notification_id,post_id:d.post_id,group_id:d.group_id},notificationUnread(db,d.user_id)),guard);}catch{result={status:0,reason:"unconfirmed"};}
  db.transaction(()=>{db.prepare("UPDATE feed_notification_outbox SET state=?,completed_at=?,reason=? WHERE id=?").run(result.status===200?"accepted":result.reason==="suppressed"?"suppressed":"failed",new Date().toISOString(),result.reason,d.id);
   if(["BadDeviceToken","DeviceTokenNotForTopic","Unregistered"].includes(result.reason))db.prepare("UPDATE feed_notification_devices SET active=0 WHERE installation_id=? AND revision=?").run(d.installation_id,d.device_revision);
  }).immediate();
 }
}
const host=globalThis as typeof globalThis&{alcorNotificationTimer?:ReturnType<typeof setInterval>;alcorNotificationBusy?:boolean};
export function startFeedNotificationWorker(){if(process.env.NODE_ENV!=="production"||host.alcorNotificationTimer)return;host.alcorNotificationTimer=setInterval(()=>{if(host.alcorNotificationBusy)return;host.alcorNotificationBusy=true;void drainFeedNotifications().catch(()=>{}).finally(()=>{host.alcorNotificationBusy=false;});},5000);host.alcorNotificationTimer.unref();}
export function notificationsDiscovery(version:1|2) {const base=`/api/v${version}/feed-notifications`,remote=apnsConfiguration().ready;return {version:1,list_path:base,read_path:base+"/read",preferences_path:base+"/preferences",devices_path:base+"/devices",publications_path:base+"/publications",publication_path:base+"/publications/{requestId}",read_scope:"feed.read",write_scope:"feed.write",remote_alerts:remote,remote_alerts_reason:remote?null:"apns_not_configured",publication_sources:["server_news","explicit_local_news_sync"],automatic_mutation_replay:false,push_type:"alert",push_content:"generic_no_financial_text"};}
