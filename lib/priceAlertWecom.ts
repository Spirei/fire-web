import type Database from 'better-sqlite3';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSiteSettings } from './settings';
import { encryptSecret, decryptSecret, hmacWithDataKey } from './secretStorage';
import { wechatReady } from './socialChannels';
import { RecordsError } from './recordsContract';
import { rateLimit } from './rateLimit';

type Binding = { user_id:string;recipient_secret:string;confirmed:number;config_stamp:string;pending_recipient_secret:string;pending_config_stamp:string;challenge_id:string;code_secret:string;code_hash:string;challenge_expires:number;attempts:number;verification_state:string;grant_id:string;created_at:number };
export class WecomRejected extends Error {}
export function wecomStamp() { const s=getSiteSettings();return hmacWithDataKey(s.wechatCorpId+'|'+s.wechatAgentId); }
export function wecomState(db:Database.Database,userId:string) {
 const row=db.prepare('SELECT * FROM price_alert_wecom WHERE user_id=?').get(userId) as Binding|undefined,stamp=wecomStamp();
 const ready=wechatReady()&&!!row?.confirmed&&row.config_stamp===stamp;
 const pending=wechatReady()&&!!row?.code_hash&&row.pending_config_stamp===stamp&&row.challenge_expires>Date.now()&&row.attempts<6&&['queued','sending','accepted','unknown'].includes(row.verification_state);
 return {channel:'wechat',configured:wechatReady(),ready,destination:ready?'企业成员 · '+decryptSecret(row!.recipient_secret,true).slice(-4):pending?'待确认 · '+decryptSecret(row!.pending_recipient_secret,true).slice(-4):'',pendingConfirmation:pending,challengeId:pending?row!.challenge_id:null,verificationState:row?.challenge_id?row.verification_state:null,verificationExpiresAt:pending?row!.challenge_expires:null};
}
export function startWecom(db:Database.Database,userId:string,grantId:string,recipient:unknown) {
 if(!wechatReady())throw new RecordsError('服务器尚未配置企业微信',503);
 if(typeof recipient!=='string'||!/^[A-Za-z0-9_@.\-]{1,64}$/.test(recipient)||recipient.toLowerCase()==='@all')throw new RecordsError('请填写单个企业成员账号（UserID）');
 // Persistent, shared per-owner and per-recipient limits; do not reset on restart.
 if(!rateLimit('wecom-bind-owner:'+userId,5,3600000)||!rateLimit('wecom-bind-recipient:'+hmacWithDataKey(wecomStamp()+'|'+recipient.toLowerCase()),5,3600000))throw new RecordsError('验证码发送过于频繁，请稍后重试',429);
 const id=randomUUID(),code=String(randomInt(100000,1000000));
 db.prepare(`INSERT INTO price_alert_wecom(user_id,pending_recipient_secret,pending_config_stamp,challenge_id,code_secret,code_hash,challenge_expires,attempts,verification_state,grant_id,created_at)
 VALUES(?,?,?,?,?,?,?,0,'queued',?,?) ON CONFLICT(user_id) DO UPDATE SET pending_recipient_secret=excluded.pending_recipient_secret,pending_config_stamp=excluded.pending_config_stamp,challenge_id=excluded.challenge_id,code_secret=excluded.code_secret,code_hash=excluded.code_hash,challenge_expires=excluded.challenge_expires,attempts=0,verification_state='queued',grant_id=excluded.grant_id,created_at=excluded.created_at`)
 .run(userId,encryptSecret(recipient),wecomStamp(),id,encryptSecret(code),hmacWithDataKey(id+'|'+code),Date.now()+300000,grantId,Date.now());
}
/** Called inside the operation transaction. False commits the failed attempt, never a binding. */
export function confirmWecom(db:Database.Database,userId:string,id:unknown,code:unknown,grantValid:(user:string,grant:string)=>boolean) {
 const row=db.prepare('SELECT * FROM price_alert_wecom WHERE user_id=?').get(userId) as Binding|undefined;
 if(!row||typeof id!=='string'||id!==row.challenge_id||row.challenge_expires<=Date.now()||!grantValid(userId,row.grant_id)||row.attempts>=6||!wechatReady()||row.pending_config_stamp!==wecomStamp()||!['sending','accepted','unknown'].includes(row.verification_state))throw new RecordsError('验证码已失效或尚未发送，请重新获取',409);
 db.prepare('UPDATE price_alert_wecom SET attempts=attempts+1 WHERE user_id=?').run(userId);
 const candidate=hmacWithDataKey(id+'|'+String(code));
 if(typeof code!=='string'||!/^\d{6}$/.test(code)||!(/^[a-f0-9]{64}$/.test(row.code_hash))||!timingSafeEqual(Buffer.from(candidate),Buffer.from(row.code_hash))) {
  if(row.attempts>=5)db.prepare("UPDATE price_alert_wecom SET verification_state='locked',code_hash='',code_secret='',pending_recipient_secret='' WHERE user_id=?").run(userId);
  return false;
 }
 db.prepare(`UPDATE price_alert_wecom SET recipient_secret=pending_recipient_secret,config_stamp=pending_config_stamp,confirmed=1,pending_recipient_secret='',pending_config_stamp='',challenge_id='',code_secret='',code_hash='',challenge_expires=0,verification_state='' WHERE user_id=?`).run(userId);
 return true;
}
export function disconnectWecom(db:Database.Database,userId:string) { db.prepare('DELETE FROM price_alert_wecom WHERE user_id=?').run(userId); }
export function wecomRecipient(db:Database.Database,userId:string) {
 if(!wecomState(db,userId).ready)return null;
 const row=db.prepare('SELECT recipient_secret FROM price_alert_wecom WHERE user_id=?').get(userId) as {recipient_secret:string};return decryptSecret(row.recipient_secret,true);
}
let cached:{key:string;token:string;until:number}|undefined;
function apiBase() {
 const raw=getSiteSettings().wechatProxyUrl||'https://qyapi.weixin.qq.com';const url=new URL(raw);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new WecomRejected('企业微信代理地址无效');
 return raw.replace(/\/$/,'')+'/';
}
async function responseJSON(response:Response) {
 if(!response.ok)throw new Error('企业微信请求未确认');
 const reader=response.body?.getReader();if(!reader)throw new Error('企业微信响应无效');
 const chunks:Uint8Array[]=[];let size=0;
 try { for(;;) { const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536)throw new Error('企业微信响应过大');chunks.push(next.value); } }
 finally { await reader.cancel().catch(()=>{}); }
 const text=Buffer.concat(chunks).toString('utf8');
 const value=JSON.parse(text) as Record<string,unknown>;
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('企业微信响应无效');return value;
}
async function accessToken() {
 if(!wechatReady())throw new WecomRejected('企业微信未配置');
 const s=getSiteSettings(),key=hmacWithDataKey(s.wechatCorpId+'|'+s.wechatAgentId+'|'+s.wechatSecret+'|'+apiBase());
 if(cached?.key===key&&cached.until>Date.now())return cached.token;
 const url=new URL('cgi-bin/gettoken',apiBase());url.searchParams.set('corpid',s.wechatCorpId);url.searchParams.set('corpsecret',s.wechatSecret);
 let value:Record<string,unknown>;try { value=await responseJSON(await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),cache:'no-store'})); } catch { throw new WecomRejected('企业微信认证未完成'); }
 if(value.errcode!==0||typeof value.access_token!=='string'||!value.access_token||typeof value.expires_in!=='number'||value.expires_in<=120)throw new WecomRejected('企业微信认证失败');
 cached={key,token:value.access_token,until:Date.now()+Math.min(7000,value.expires_in-120)*1000};return cached.token;
}
export async function sendWecomText(recipient:string,content:string,authorize:()=>boolean=()=>true) {
 if(!/^[A-Za-z0-9_@.\-]{1,64}$/.test(recipient)||recipient.toLowerCase()==='@all')throw new WecomRejected('接收成员无效');
 const stamp=wecomStamp(),base=apiBase(),agent=Number(getSiteSettings().wechatAgentId),token=await accessToken();
 if(!authorize()||!wechatReady()||stamp!==wecomStamp()||base!==apiBase())throw new WecomRejected('企业微信应用配置已变化');
 const url=new URL('cgi-bin/message/send',base);url.searchParams.set('access_token',token);
 const value=await responseJSON(await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({touser:recipient,msgtype:'text',agentid:agent,text:{content},safe:1,enable_duplicate_check:1,duplicate_check_interval:1800}),signal:AbortSignal.timeout(15000),cache:'no-store'}));
 if(value.errcode===40014||value.errcode===42001)cached=undefined;
 if(value.errcode!==0||value.invaliduser||value.invalidparty||value.invalidtag)throw new WecomRejected('企业微信拒绝接收');
 if(typeof value.msgid!=='string'||!value.msgid)throw new Error('企业微信接收结果未确认');
}
export async function deliverWecomChallenges(db:Database.Database,grantValid:(user:string,grant:string)=>boolean,touch:(user:string)=>void) {
 const now=Date.now();
 db.prepare("UPDATE price_alert_wecom SET verification_state='unknown',code_secret='' WHERE verification_state='sending' AND created_at<?").run(now-60000);
 db.prepare("UPDATE price_alert_wecom SET verification_state='expired',code_secret='',code_hash='',pending_recipient_secret='' WHERE challenge_expires<=? AND code_hash!=''").run(now);
 const rows=db.prepare("SELECT * FROM price_alert_wecom WHERE verification_state='queued' AND challenge_expires>? ORDER BY created_at LIMIT 3").all(now) as Binding[];
 for(const row of rows) {
  if(!grantValid(row.user_id,row.grant_id)||!wechatReady()||row.pending_config_stamp!==wecomStamp()) { db.prepare("UPDATE price_alert_wecom SET verification_state='cancelled',code_secret='',code_hash='',pending_recipient_secret='' WHERE user_id=? AND challenge_id=?").run(row.user_id,row.challenge_id);touch(row.user_id);continue; }
  if(!db.prepare("UPDATE price_alert_wecom SET verification_state='sending' WHERE user_id=? AND challenge_id=? AND verification_state='queued'").run(row.user_id,row.challenge_id).changes)continue;
  touch(row.user_id);
  let state='accepted';try { await sendWecomText(decryptSecret(row.pending_recipient_secret,true),'Alcor 绑定验证码：'+decryptSecret(row.code_secret,true)+'。5分钟内有效。仅在本人主动绑定时输入，请勿向他人提供。',()=>grantValid(row.user_id,row.grant_id)&&!!db.prepare("SELECT 1 FROM price_alert_wecom WHERE user_id=? AND challenge_id=? AND verification_state='sending' AND challenge_expires>?").get(row.user_id,row.challenge_id,Date.now())); } catch(error) { state=error instanceof WecomRejected?'failed':'unknown'; }
  db.prepare("UPDATE price_alert_wecom SET verification_state=?,code_secret='',code_hash=CASE WHEN ?='failed' THEN '' ELSE code_hash END WHERE user_id=? AND challenge_id=? AND verification_state='sending'").run(state,state,row.user_id,row.challenge_id);touch(row.user_id);
 }
}
