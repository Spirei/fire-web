import type Database from 'better-sqlite3';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSiteSettings } from './settings';
import { encryptSecret, decryptSecret, hmacWithDataKey } from './secretStorage';
import { discordReady, feishuReady, qqReady } from './socialChannels';
import { RecordsError } from './recordsContract';
import { rateLimit } from './rateLimit';

export type MessengerChannel = 'feishu' | 'discord' | 'qq';
type Binding = { user_id:string;channel:string;recipient_secret:string;confirmed:number;config_stamp:string;pending_recipient_secret:string;pending_config_stamp:string;challenge_id:string;code_secret:string;code_hash:string;challenge_expires:number;attempts:number;verification_state:string;grant_id:string;created_at:number };
export class MessengerRejected extends Error {}
const titles: Record<MessengerChannel,string> = { feishu:'飞书', discord:'Discord', qq:'QQ' };
export function isMessengerChannel(value:unknown): value is MessengerChannel { return value==='feishu'||value==='discord'||value==='qq'; }
export function messengerStamp(channel:MessengerChannel) {
  const settings=getSiteSettings();
  if(channel==='feishu')return hmacWithDataKey(settings.feishuAppId+'|'+settings.feishuAppSecret);
  if(channel==='discord')return hmacWithDataKey(settings.discordBotToken);
  return hmacWithDataKey(settings.qqAppId+'|'+settings.qqAppSecret);
}
export function messengerReady(channel:MessengerChannel) { return channel==='feishu'?feishuReady():channel==='discord'?discordReady():qqReady(); }
export function acceptMessengerRecipient(channel:MessengerChannel,recipient:string) {
  if(channel==='feishu')return /^ou_[A-Za-z0-9]{16,64}$/.test(recipient)||/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,80}\.[A-Za-z]{2,24}$/.test(recipient);
  if(channel==='discord')return /^\d{17,20}$/.test(recipient);
  return /^[A-Za-z0-9]{16,64}$/.test(recipient);
}
function masked(channel:MessengerChannel,recipient:string) {
  if(channel==='feishu'&&recipient.includes('@')){const [name,domain]=recipient.split('@');return `飞书 · ${name.slice(0,2)}***@${domain}`;}
  return `${titles[channel]} · ${recipient.slice(-4)}`;
}
export function messengerState(db:Database.Database,userId:string,channel:MessengerChannel) {
  const row=db.prepare('SELECT * FROM price_alert_messengers WHERE user_id=? AND channel=?').get(userId,channel) as Binding|undefined,stamp=messengerStamp(channel),readyConfig=messengerReady(channel);
  const ready=readyConfig&&!!row?.confirmed&&row.config_stamp===stamp;
  const pending=readyConfig&&!!row?.code_hash&&row.pending_config_stamp===stamp&&row.challenge_expires>Date.now()&&row.attempts<6&&['queued','sending','accepted','unknown'].includes(row.verification_state);
  const shown=ready?decryptSecret(row!.recipient_secret,true):pending?decryptSecret(row!.pending_recipient_secret,true):'';
  return {channel,configured:readyConfig,ready,destination:shown?masked(channel,shown):'',pendingConfirmation:pending,challengeId:pending?row!.challenge_id:null,verificationState:row?.challenge_id?row.verification_state:null,verificationExpiresAt:pending?row!.challenge_expires:null};
}
export function startMessenger(db:Database.Database,userId:string,grantId:string,channel:MessengerChannel,recipient:unknown) {
  if(!messengerReady(channel))throw new RecordsError(`服务器尚未配置${titles[channel]}`,503);
  if(typeof recipient!=='string'||!acceptMessengerRecipient(channel,recipient))throw new RecordsError(channel==='feishu'?'请填写单个飞书 open_id 或邮箱':channel==='discord'?'请填写单个 Discord 用户 ID':'请填写单个 QQ 用户 openid');
  if(!rateLimit(`messenger-bind-owner:${channel}:${userId}`,5,3600000)||!rateLimit(`messenger-bind-recipient:${channel}:${hmacWithDataKey(messengerStamp(channel)+'|'+recipient)}`,5,3600000))throw new RecordsError('验证码发送过于频繁，请稍后重试',429);
  const id=randomUUID(),code=String(randomInt(100000,1000000));
  db.prepare(`INSERT INTO price_alert_messengers(user_id,channel,pending_recipient_secret,pending_config_stamp,challenge_id,code_secret,code_hash,challenge_expires,attempts,verification_state,grant_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,0,'queued',?,?) ON CONFLICT(user_id,channel) DO UPDATE SET pending_recipient_secret=excluded.pending_recipient_secret,pending_config_stamp=excluded.pending_config_stamp,challenge_id=excluded.challenge_id,code_secret=excluded.code_secret,code_hash=excluded.code_hash,challenge_expires=excluded.challenge_expires,attempts=0,verification_state='queued',grant_id=excluded.grant_id,created_at=excluded.created_at`)
    .run(userId,channel,encryptSecret(recipient),messengerStamp(channel),id,encryptSecret(code),hmacWithDataKey(id+'|'+code),Date.now()+300000,grantId,Date.now());
}
/** Called inside the operation transaction. False commits the failed attempt, never a binding. */
export function confirmMessenger(db:Database.Database,userId:string,channel:MessengerChannel,id:unknown,code:unknown,grantValid:(user:string,grant:string)=>boolean) {
  const row=db.prepare('SELECT * FROM price_alert_messengers WHERE user_id=? AND channel=?').get(userId,channel) as Binding|undefined;
  if(!row||typeof id!=='string'||id!==row.challenge_id||row.challenge_expires<=Date.now()||!grantValid(userId,row.grant_id)||row.attempts>=6||!messengerReady(channel)||row.pending_config_stamp!==messengerStamp(channel)||!['sending','accepted','unknown'].includes(row.verification_state))throw new RecordsError('验证码已失效或尚未发送，请重新获取',409);
  db.prepare('UPDATE price_alert_messengers SET attempts=attempts+1 WHERE user_id=? AND channel=?').run(userId,channel);
  const candidate=hmacWithDataKey(id+'|'+String(code));
  if(typeof code!=='string'||!/^\d{6}$/.test(code)||!/^[a-f0-9]{64}$/.test(row.code_hash)||!timingSafeEqual(Buffer.from(candidate),Buffer.from(row.code_hash))) {
    if(row.attempts>=5)db.prepare("UPDATE price_alert_messengers SET verification_state='locked',code_hash='',code_secret='',pending_recipient_secret='' WHERE user_id=? AND channel=?").run(userId,channel);
    return false;
  }
  db.prepare(`UPDATE price_alert_messengers SET recipient_secret=pending_recipient_secret,config_stamp=pending_config_stamp,confirmed=1,pending_recipient_secret='',pending_config_stamp='',challenge_id='',code_secret='',code_hash='',challenge_expires=0,verification_state='' WHERE user_id=? AND channel=?`).run(userId,channel);
  return true;
}
export function disconnectMessenger(db:Database.Database,userId:string,channel:MessengerChannel) { db.prepare('DELETE FROM price_alert_messengers WHERE user_id=? AND channel=?').run(userId,channel); }
export function messengerRecipient(db:Database.Database,userId:string,channel:MessengerChannel) {
  if(!messengerState(db,userId,channel).ready)return null;
  const row=db.prepare('SELECT recipient_secret FROM price_alert_messengers WHERE user_id=? AND channel=?').get(userId,channel) as {recipient_secret:string};return decryptSecret(row.recipient_secret,true);
}
const tokens=new Map<string,{token:string;until:number}>();
async function readBody(response:Response,label:string) {
  if(response.status>=400&&response.status<500)throw new MessengerRejected(label+'拒绝接收');
  if(!response.ok)throw new Error(label+'请求未确认');
  const reader=response.body?.getReader();if(!reader)throw new Error(label+'响应无效');
  const chunks:Uint8Array[]=[];let size=0;
  try { for(;;){ const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536)throw new Error(label+'响应过大');chunks.push(next.value);} }
  finally { await reader.cancel().catch(()=>{}); }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(label+'响应无效');
  return value as Record<string,unknown>;
}
async function postJSON(url:string,headers:Record<string,string>,body:unknown,label:string) {
  return readBody(await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(15000),cache:'no-store'}),label);
}
async function cachedToken(key:string,load:()=>Promise<{token:string;expires:number}>) {
  const hit=tokens.get(key);if(hit&&hit.until>Date.now())return hit.token;
  const fresh=await load();tokens.set(key,{token:fresh.token,until:Date.now()+Math.min(7000,fresh.expires-120)*1000});return fresh.token;
}
async function feishuToken() {
  if(!feishuReady())throw new MessengerRejected('飞书未配置');
  const settings=getSiteSettings(),key=hmacWithDataKey('feishu|'+settings.feishuAppId+'|'+settings.feishuAppSecret);
  return cachedToken(key,async()=>{
    let value:Record<string,unknown>;
    try { value=await postJSON('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{},{app_id:settings.feishuAppId,app_secret:settings.feishuAppSecret},'飞书'); }
    catch(error){ if(error instanceof MessengerRejected)throw error;throw new MessengerRejected('飞书认证未完成'); }
    const expire=Number(value.expire);
    if(value.code!==0||typeof value.tenant_access_token!=='string'||!value.tenant_access_token||!Number.isFinite(expire)||expire<=120)throw new MessengerRejected('飞书认证失败');
    return {token:value.tenant_access_token,expires:expire};
  });
}
async function qqToken() {
  if(!qqReady())throw new MessengerRejected('QQ 未配置');
  const settings=getSiteSettings(),key=hmacWithDataKey('qq|'+settings.qqAppId+'|'+settings.qqAppSecret);
  return cachedToken(key,async()=>{
    let value:Record<string,unknown>;
    try { value=await postJSON('https://bots.qq.com/app/getAppAccessToken',{},{appId:settings.qqAppId,clientSecret:settings.qqAppSecret},'QQ'); }
    catch(error){ if(error instanceof MessengerRejected)throw error;throw new MessengerRejected('QQ 认证未完成'); }
    const expire=Number(value.expires_in);
    if(typeof value.access_token!=='string'||!value.access_token||!Number.isFinite(expire)||expire<=120)throw new MessengerRejected('QQ 认证失败');
    return {token:value.access_token,expires:expire};
  });
}
async function sendFeishu(recipient:string,content:string,authorize:()=>boolean) {
  if(!acceptMessengerRecipient('feishu',recipient))throw new MessengerRejected('飞书接收账号无效');
  const stamp=messengerStamp('feishu'),token=await feishuToken();
  if(!authorize()||!feishuReady()||stamp!==messengerStamp('feishu'))throw new MessengerRejected('飞书应用配置已变化');
  const url=new URL('https://open.feishu.cn/open-apis/im/v1/messages');url.searchParams.set('receive_id_type',recipient.startsWith('ou_')?'open_id':'email');
  const value=await postJSON(url.toString(),{Authorization:'Bearer '+token},{receive_id:recipient,msg_type:'text',content:JSON.stringify({text:content.slice(0,1800)})},'飞书');
  const data=value.data;if(value.code!==0)throw new MessengerRejected('飞书拒绝接收');
  if(!data||typeof data!=='object'||Array.isArray(data)||typeof (data as {message_id?:unknown}).message_id!=='string'||!(data as {message_id:string}).message_id)throw new Error('飞书接收结果未确认');
}
async function sendDiscord(recipient:string,content:string,authorize:()=>boolean) {
  if(!acceptMessengerRecipient('discord',recipient))throw new MessengerRejected('Discord 用户无效');
  const token=getSiteSettings().discordBotToken,stamp=messengerStamp('discord');
  if(!discordReady()||token.length>200||/[\s\x00-\x1f]/.test(token))throw new MessengerRejected('Discord 未配置');
  if(!authorize())throw new MessengerRejected('Discord 绑定已变化');
  const headers={Authorization:'Bot '+token,'user-agent':'AlcorPriceAlerts (https://alcor.app, 1)'};
  let channelId='';
  try {
    const opened=await postJSON('https://discord.com/api/v10/users/@me/channels',headers,{recipient_id:recipient},'Discord');
    if(typeof opened.id==='string'&&/^\d{17,22}$/.test(opened.id))channelId=opened.id;
  } catch(error){ if(error instanceof MessengerRejected)throw error;throw new MessengerRejected('Discord 私信通道未建立'); }
  if(!channelId||!authorize()||stamp!==messengerStamp('discord')||!discordReady())throw new MessengerRejected('Discord 配置已变化');
  const message=await postJSON(`https://discord.com/api/v10/channels/${channelId}/messages`,headers,{content:content.slice(0,1800)},'Discord');
  if(typeof message.id!=='string'||!/^\d{17,22}$/.test(message.id))throw new Error('Discord 接收结果未确认');
}
async function sendQQ(recipient:string,content:string,authorize:()=>boolean) {
  if(!acceptMessengerRecipient('qq',recipient))throw new MessengerRejected('QQ 接收账号无效');
  const stamp=messengerStamp('qq'),token=await qqToken(),appId=getSiteSettings().qqAppId;
  if(!authorize()||!qqReady()||stamp!==messengerStamp('qq'))throw new MessengerRejected('QQ 应用配置已变化');
  const value=await postJSON(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(recipient)}/messages`,{Authorization:'QQBot '+token,'X-Union-Appid':appId},{content:content.slice(0,1800),msg_type:0},'QQ');
  if(typeof value.code==='number'&&value.code!==0)throw new MessengerRejected('QQ 拒绝接收');
  if(typeof value.id!=='string'||!value.id||value.id.length>128)throw new Error('QQ 接收结果未确认');
}
export async function sendMessenger(channel:MessengerChannel,recipient:string,content:string,authorize:()=>boolean=()=>true) {
  if(channel==='feishu')return sendFeishu(recipient,content,authorize);
  if(channel==='discord')return sendDiscord(recipient,content,authorize);
  return sendQQ(recipient,content,authorize);
}
export async function deliverMessengerChallenges(db:Database.Database,grantValid:(user:string,grant:string)=>boolean,touch:(user:string)=>void) {
  const now=Date.now();
  db.prepare("UPDATE price_alert_messengers SET verification_state='unknown',code_secret='' WHERE verification_state='sending' AND created_at<?").run(now-60000);
  db.prepare("UPDATE price_alert_messengers SET verification_state='expired',code_secret='',code_hash='',pending_recipient_secret='' WHERE challenge_expires<=? AND code_hash!=''").run(now);
  const rows=db.prepare("SELECT * FROM price_alert_messengers WHERE verification_state='queued' AND challenge_expires>? ORDER BY created_at LIMIT 3").all(now) as Binding[];
  for(const row of rows) {
    if(!isMessengerChannel(row.channel))continue;
    const channel=row.channel;
    if(!grantValid(row.user_id,row.grant_id)||!messengerReady(channel)||row.pending_config_stamp!==messengerStamp(channel)){db.prepare("UPDATE price_alert_messengers SET verification_state='cancelled',code_secret='',code_hash='',pending_recipient_secret='' WHERE user_id=? AND channel=? AND challenge_id=?").run(row.user_id,channel,row.challenge_id);touch(row.user_id);continue;}
    if(!db.prepare("UPDATE price_alert_messengers SET verification_state='sending' WHERE user_id=? AND channel=? AND challenge_id=? AND verification_state='queued'").run(row.user_id,channel,row.challenge_id).changes)continue;
    touch(row.user_id);
    let state='accepted';
    try { await sendMessenger(channel,decryptSecret(row.pending_recipient_secret,true),'Alcor 绑定验证码：'+decryptSecret(row.code_secret,true)+'。5分钟内有效。仅在本人主动绑定时输入，请勿向他人提供。',()=>grantValid(row.user_id,row.grant_id)&&!!db.prepare("SELECT 1 FROM price_alert_messengers WHERE user_id=? AND channel=? AND challenge_id=? AND verification_state='sending' AND challenge_expires>?").get(row.user_id,channel,row.challenge_id,Date.now())); }
    catch(error){ state=error instanceof MessengerRejected?'failed':'unknown'; }
    db.prepare("UPDATE price_alert_messengers SET verification_state=?,code_secret='',code_hash=CASE WHEN ?='failed' THEN '' ELSE code_hash END WHERE user_id=? AND channel=? AND challenge_id=? AND verification_state='sending'").run(state,state,row.user_id,channel,row.challenge_id);touch(row.user_id);
  }
}
