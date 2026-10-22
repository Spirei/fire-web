import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { installPriceAlerts } from './priceAlertsSchema';
import { appSecurityStamp } from './appAuth';
import { emailVerified } from './emailVerification';
import { mailConfigured } from './mail';
import { wecomState,startWecom,confirmWecom,disconnectWecom } from './priceAlertWecom';
import { messengerState,startMessenger,confirmMessenger,disconnectMessenger,isMessengerChannel,type MessengerChannel } from './priceAlertMessengers';
import { telegramReady, telegramBotUsername } from './socialChannels';
import { encryptSecret, decryptSecret } from './secretStorage';
import { RecordsError } from './recordsContract';
import { tradingQuoteTime } from './appTrading';
import { marketSessionState } from './marketSessions';
import { normalizeMarketCode } from './marketCode';
import type { Quote } from './quotes';
export type AlertChannel = 'app' | 'email' | 'telegram' | 'wechat' | 'feishu' | 'discord' | 'qq';
export type AlertConfig = { id: string; name: string; code: string; market: 'US'|'HK'|'CN'; direction: 'above'|'below'; price: string; extended: boolean; frequency: 'once'|'daily'; expiresAt: number|null };
export type AlertRow = { user_id: string; id: string; grant_id: string; revision: number; config: string; state: string; activated_at: number; last_quote_at: number };
type GrantIdentity = { id: string; user_id: string };
type Telegram = { user_id:string; chat_secret:string; label:string; confirmed:number; challenge_hash:string|null; challenge_expires:number };
export const channels: AlertChannel[] = ['app','email','telegram','wechat','feishu','discord','qq'];
const preferenceColumn: Record<AlertChannel,string> = {app:'app',email:'email',telegram:'telegram',wechat:'wechat',feishu:'feishu',discord:'discord',qq:'qq'};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const bad = (message: string, status = 400): never => { throw new RecordsError(message, status); };
export function alertDb() { const db=getDb(); installPriceAlerts(db); return db; }
export function touchAlertOwner(userId:string) { alertDb().prepare('INSERT INTO price_alert_collections VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1').run(userId); }
export function telegramConfigured() { return telegramReady() && /^[A-Za-z0-9_]{5,32}$/.test(telegramBotUsername()); }
export function alertsAvailable() { return process.env.ALCOR_PRICE_ALERTS_ENABLED !== 'false'; }
export function priceAlertsDiscovery(version:1|2) {
  const base=`/api/v${version}/price-alerts`;
  return { version:1, snapshot_path:base, operation_path:`${base}/operations/{requestId}`, read_scope:'portfolio.read', write_scope:'portfolio.write',
    channels:['app','email','telegram'], wechat:{version:1,binding:'verification-code'}, messengers:{version:1,binding:'verification-code',channels:['feishu','discord','qq']}, worker:'server', interval_seconds:5, idempotency:'query-original-no-replay', monitoring_available:alertsAvailable() };
}
export function decimalMicros(value:unknown): bigint|null {
  if(typeof value!=='string' || !/^\d{1,10}(?:\.\d{1,6})?$/.test(value))return null;
  const [whole,part='']=value.split('.'); const result=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
  return result>0n?result:null;
}
export function parseAlert(value:unknown):AlertConfig {
  if(!value || typeof value!=='object' || Array.isArray(value))return bad('提醒数据无效');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['id','name','code','market','direction','price','extended','frequency','expiresAt'].includes(k)))return bad('提醒包含不支持的字段');
  if(!uuid(v.id)||typeof v.name!=='string'||!v.name.trim()||v.name.length>80||/[\x00-\x1f\x7f]/.test(v.name)||typeof v.code!=='string'||(typeof v.market!=='string'||!['US','HK','CN'].includes(v.market))||(typeof v.direction!=='string'||!['above','below'].includes(v.direction))||!decimalMicros(v.price)||typeof v.extended!=='boolean'||(typeof v.frequency!=='string'||!['once','daily'].includes(v.frequency)))return bad('股票或目标价格无效');
  const code=normalizeMarketCode(String(v.market),v.code.trim().toUpperCase());
  if(!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(code))return bad('股票代码无效');
  if(v.expiresAt!==null && v.expiresAt!==undefined && (typeof v.expiresAt!=='number'||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=Date.now()||v.expiresAt>Date.now()+3650*86400000))return bad('到期日无效');
  return { id:v.id.toLowerCase(),name:v.name.trim(),code,market:v.market as AlertConfig['market'],direction:v.direction as AlertConfig['direction'],price:v.price as string,extended:v.market==='US'&&v.extended,frequency:v.frequency as AlertConfig['frequency'],expiresAt:(v.expiresAt??null) as number|null };
}
function preferences(userId:string) {
  const db=alertDb();db.prepare('INSERT OR IGNORE INTO price_alert_preferences(user_id) VALUES(?)').run(userId);
  return db.prepare('SELECT * FROM price_alert_preferences WHERE user_id=?').get(userId) as {revision:number;app:number;email:number;telegram:number;wechat:number;feishu:number;discord:number;qq:number};
}
export function channelState(userId:string) {
  const db=alertDb(),pref=preferences(userId);
  const user=db.prepare('SELECT email FROM users WHERE id=?').get(userId) as {email:string}|undefined;
  const tg=db.prepare('SELECT * FROM price_alert_telegram WHERE user_id=?').get(userId) as Telegram|undefined;
  const emailReady=!!user?.email && emailVerified(userId,user.email)&&mailConfigured();
  return [
    {channel:'app',enabled:!!pref.app,ready:true,configured:true,destination:'App 内',pendingConfirmation:false},
    {channel:'email',enabled:!!pref.email,ready:emailReady,configured:mailConfigured(),destination:user?.email ? user.email.slice(0,2)+'***@'+user.email.split('@')[1] : '',pendingConfirmation:false},
    {channel:'telegram',enabled:!!pref.telegram,ready:telegramConfigured()&&!!tg?.confirmed,configured:telegramConfigured(),destination:tg?.chat_secret?tg.label:'',pendingConfirmation:!!tg?.chat_secret&&!tg.confirmed},
    {...wecomState(db,userId),enabled:!!pref.wechat},
    {...messengerState(db,userId,'feishu'),enabled:!!pref.feishu},
    {...messengerState(db,userId,'discord'),enabled:!!pref.discord},
    {...messengerState(db,userId,'qq'),enabled:!!pref.qq}
  ];
}
export function grantAlive(userId:string,grantId:string,now=Date.now()) {
  const row=alertDb().prepare(`SELECT g.*,u.password_hash,u.totp_secret,u.totp_enabled FROM app_grants g JOIN users u ON u.id=g.user_id WHERE g.id=? AND g.user_id=?`).get(grantId,userId) as {revoked_at:number|null;expires_at:number;created_at:number;scope:string;security_stamp:string;password_hash:string;totp_secret:string;totp_enabled:number}|undefined;
  return !!row && row.revoked_at===null&&row.expires_at>now&&row.created_at+90*86400000>now&&row.scope.split(' ').includes('portfolio.write')&&row.security_stamp===appSecurityStamp(row);
}
export function alertSnapshot(userId:string) {
  const db=alertDb();
  const rows=db.prepare('SELECT * FROM price_alert_rules WHERE user_id=? ORDER BY activated_at DESC,id').all(userId) as AlertRow[];
  const events=db.prepare('SELECT id,data,read_at FROM price_alert_events WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(userId) as {id:string;data:string;read_at:number|null}[];
  return {accountId:userId,revision:(db.prepare('SELECT revision FROM price_alert_collections WHERE user_id=?').get(userId) as {revision:number}|undefined)?.revision??0,asOf:Date.now(),unreadCount:(db.prepare("SELECT COUNT(DISTINCT e.id) n FROM price_alert_events e JOIN price_alert_deliveries d ON d.event_id=e.id WHERE e.user_id=? AND e.read_at IS NULL AND d.channel='app' AND d.state='delivered'").get(userId) as {n:number}).n,channels:channelState(userId),channelRevision:preferences(userId).revision,
    rules:rows.map(r=>({rule:JSON.parse(r.config) as AlertConfig,revision:r.revision,status:!grantAlive(userId,r.grant_id)&&r.state==='enabled'?'paused':r.state})),
    events:events.map(e=>({...JSON.parse(e.data),id:e.id,read:e.read_at!==null,deliveries:db.prepare('SELECT channel,state FROM price_alert_deliveries WHERE event_id=? AND user_id=?').all(e.id,userId)}))};
}
export function alertOperation(userId:string,requestId:string) {
  if(!uuid(requestId))return bad('请求编号无效');
  const row=alertDb().prepare('SELECT result FROM price_alert_operations WHERE user_id=? AND request_id=?').get(userId,requestId.toLowerCase()) as {result:string}|undefined;
  if(!row)return bad('操作回执不存在',404);return JSON.parse(row.result);
}
export function mutateAlert(grant:GrantIdentity,requestId:string,body:unknown,authorize:()=>void) {
  if(!uuid(requestId))return bad('请求编号无效');
  if(!body||typeof body!=='object'||Array.isArray(body))return bad('请求无效');
  const b=body as Record<string,unknown>,db=alertDb(),userId=grant.user_id;
  const outcome=db.transaction(()=>{
    authorize();if(!alertsAvailable())bad('股价监控尚未启用',503);
    if(db.prepare('SELECT 1 FROM price_alert_operations WHERE user_id=? AND request_id=?').get(userId,requestId.toLowerCase()))bad('重复请求，请查询原回执',409);
    const action=b.action;
    if(action==='upsert'||action==='delete'||action==='state') {
      if(!uuid(b.ruleId))bad('提醒编号无效');
      const id=String(b.ruleId).toLowerCase(),old=db.prepare('SELECT * FROM price_alert_rules WHERE user_id=? AND id=?').get(userId,id) as AlertRow|undefined;
      if((old?.revision??0)!==b.revision)bad('提醒已变化，请刷新后重试',409);
      if(action==='delete') {if(!old)bad('提醒不存在',404);db.prepare('DELETE FROM price_alert_rules WHERE user_id=? AND id=?').run(userId,id);}
      else if(action==='state') {
        if(!old||typeof b.state!=='string'||!['enabled','paused'].includes(b.state))bad('提醒状态无效');
        if(b.state==='enabled'){const config=JSON.parse(old!.config) as AlertConfig;if(config.expiresAt!==null&&config.expiresAt<=Date.now())bad('提醒已过期，请先更改有效期',409);}
        db.prepare('UPDATE price_alert_rules SET state=?,revision=revision+1,grant_id=?,activated_at=?,last_quote_at=0 WHERE user_id=? AND id=?').run(b.state,grant.id,Date.now(),userId,id);
      } else {
        const rule=parseAlert(b.rule);if(rule.id!==id)bad('提醒编号不匹配');
        if(!old&&(db.prepare('SELECT COUNT(*) AS n FROM price_alert_rules WHERE user_id=?').get(userId) as {n:number}).n>=200)bad('最多保存200条提醒',409);
        db.prepare(`INSERT INTO price_alert_rules(user_id,id,grant_id,revision,config,state,activated_at) VALUES(?,?,?,?,?,'enabled',?) ON CONFLICT(user_id,id) DO UPDATE SET grant_id=excluded.grant_id,revision=excluded.revision,config=excluded.config,state=CASE WHEN price_alert_rules.state='paused' THEN 'paused' ELSE 'enabled' END,activated_at=excluded.activated_at,last_quote_at=0`).run(userId,id,grant.id,(old?.revision??0)+1,JSON.stringify(rule),Date.now());
      }
    } else if(action==='channel') {
      if(!channels.includes(b.channel as AlertChannel)||typeof b.enabled!=='boolean')bad('通知方式无效');
      const pref=preferences(userId);if(pref.revision!==b.revision)bad('通知设置已变化，请刷新后重试',409);
      if(b.enabled&&!channelState(userId).find(c=>c.channel===b.channel)?.ready)bad('请先完成此通知方式的绑定',409);
      db.prepare(`UPDATE price_alert_preferences SET ${preferenceColumn[b.channel as AlertChannel]}=?,revision=revision+1 WHERE user_id=?`).run(b.enabled?1:0,userId);
     } else if(action==='test') {
      if(!channels.includes(b.channel as AlertChannel)||!channelState(userId).find(c=>c.channel===b.channel)?.ready)bad('此通知方式尚未完成配置',409);
      const id=randomUUID(),now=Date.now(),data={id,ruleId:'',kind:'test',grantId:grant.id,name:'Alcor',code:'',market:'',currency:'',direction:'above',target:'0',price:0,session:'',quoteTime:'',createdAt:now};
      db.prepare('INSERT INTO price_alert_events VALUES(?,?,?,?,?,?,?,NULL)').run(id,userId,'',0,id,JSON.stringify(data),now);
      db.prepare('INSERT INTO price_alert_deliveries VALUES(?,?,?,?,?,?)').run(randomUUID(),userId,id,b.channel,b.channel==='app'?'delivered':'queued',now);
    } else if(action==='read') {
      if(typeof b.allThrough==='number' && Number.isSafeInteger(b.allThrough) && b.allThrough<=Date.now() && b.allThrough>0) {
        db.prepare('UPDATE price_alert_events SET read_at=? WHERE user_id=? AND created_at<=?').run(Date.now(),userId,b.allThrough);
      } else {
      if(!Array.isArray(b.eventIds)||b.eventIds.length>200||!b.eventIds.every(uuid))bad('通知编号无效');
      for(const id of b.eventIds as string[])db.prepare('UPDATE price_alert_events SET read_at=? WHERE user_id=? AND id=?').run(Date.now(),userId,id);
      }
    } else if(action==='wechat_start'||action==='wechat_confirm'||action==='wechat_disconnect') {
      const pref=preferences(userId);if(pref.revision!==b.revision)bad('通知设置已变化，请刷新后重试',409);
      if(action==='wechat_start')startWecom(db,userId,grant.id,b.recipient);
      else if(action==='wechat_disconnect') { disconnectWecom(db,userId);db.prepare('UPDATE price_alert_preferences SET wechat=0 WHERE user_id=?').run(userId); }
      else {
        if(!confirmWecom(db,userId,b.challengeId,b.verificationCode,grantAlive)){touchAlertOwner(userId);return {bindingError:true as const};}
        if(b.enabled!==undefined&&typeof b.enabled!=='boolean')bad('启用状态无效');
        db.prepare('UPDATE price_alert_preferences SET wechat=? WHERE user_id=?').run(b.enabled===true?1:0,userId);
      }
      db.prepare('UPDATE price_alert_preferences SET revision=revision+1 WHERE user_id=?').run(userId);
    } else if(isMessengerChannel(String(action).split('_')[0])&&/^(feishu|discord|qq)_(start|confirm|disconnect)$/.test(String(action))) {
      const channel=String(action).split('_')[0] as MessengerChannel,op=String(action).split('_')[1];
      const pref=preferences(userId);if(pref.revision!==b.revision)bad('通知设置已变化，请刷新后重试',409);
      if(op==='start')startMessenger(db,userId,grant.id,channel,b.recipient);
      else if(op==='disconnect'){disconnectMessenger(db,userId,channel);db.prepare(`UPDATE price_alert_preferences SET ${preferenceColumn[channel]}=0 WHERE user_id=?`).run(userId);}
      else {
        if(!confirmMessenger(db,userId,channel,b.challengeId,b.verificationCode,grantAlive)){touchAlertOwner(userId);return {bindingError:true as const};}
        if(b.enabled!==undefined&&typeof b.enabled!=='boolean')bad('启用状态无效');
        db.prepare(`UPDATE price_alert_preferences SET ${preferenceColumn[channel]}=? WHERE user_id=?`).run(b.enabled===true?1:0,userId);
      }
      db.prepare('UPDATE price_alert_preferences SET revision=revision+1 WHERE user_id=?').run(userId);
    } else if(action==='telegram_confirm') {
      if(b.revision!==preferences(userId).revision)bad('绑定已变化，请刷新后确认',409);
      const tg=db.prepare('SELECT * FROM price_alert_telegram WHERE user_id=?').get(userId) as Telegram|undefined;
      if(!tg?.chat_secret||tg.confirmed||!telegramConfigured())bad('没有待确认的Telegram绑定',409);
      db.prepare('UPDATE price_alert_telegram SET confirmed=1 WHERE user_id=?').run(userId);
      if(b.enabled===true)db.prepare('UPDATE price_alert_preferences SET telegram=1,revision=revision+1 WHERE user_id=?').run(userId);
    } else if(action==='telegram_disconnect') {
      if(b.revision!==preferences(userId).revision)bad('绑定已变化，请刷新后重试',409);
      db.prepare('DELETE FROM price_alert_telegram WHERE user_id=?').run(userId);
      db.prepare('UPDATE price_alert_preferences SET telegram=0,revision=revision+1 WHERE user_id=?').run(userId);
    } else bad('不支持的提醒操作');
    touchAlertOwner(userId);
    const result={requestId:requestId.toLowerCase(),state:'completed',snapshot:alertSnapshot(userId)};
    db.prepare('INSERT INTO price_alert_operations VALUES(?,?,?)').run(userId,requestId.toLowerCase(),JSON.stringify(result));return result;
  }).immediate();
  if('bindingError' in outcome)bad('验证码不正确',400);
  return outcome;
}
export function beginTelegram(userId:string) {
  if(!telegramConfigured())bad('服务器尚未配置Telegram机器人',503);
  const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex');
  alertDb().prepare(`INSERT INTO price_alert_telegram(user_id,chat_secret,label,challenge_hash,challenge_expires) VALUES(?,'','',?,?) ON CONFLICT(user_id) DO UPDATE SET challenge_hash=excluded.challenge_hash,challenge_expires=excluded.challenge_expires`).run(userId,hash,Date.now()+300000);
  return {url:`https://t.me/${telegramBotUsername()}?start=${token}`,expiresAt:Date.now()+300000};
}
export function receiveTelegram(value:unknown) {
  const v=value as {message?:{text?:string;from?:{id?:number;username?:string;first_name?:string};chat?:{id?:number;type?:string}}};
  const message=v?.message,token=message?.text?.match(/^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{43})$/)?.[1];
  if(!token||message?.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||message.chat.id!==message.from?.id)return;
  const db=alertDb();db.transaction(()=>{
    const row=db.prepare('SELECT * FROM price_alert_telegram WHERE challenge_hash=? AND challenge_expires>?').get(createHash('sha256').update(token).digest('hex'),Date.now()) as Telegram|undefined;
    if(!row)return;
    const label=(message.from?.username?'@'+message.from.username:message.from?.first_name||'Telegram').replace(/[\x00-\x1f\x7f]/g,'').slice(0,80);
    db.prepare('UPDATE price_alert_telegram SET chat_secret=?,label=?,confirmed=0,challenge_hash=NULL,challenge_expires=0 WHERE user_id=?').run(encryptSecret(String(message.chat!.id)),label,row.user_id);
    db.prepare('UPDATE price_alert_preferences SET telegram=0,revision=revision+1 WHERE user_id=?').run(row.user_id);
    touchAlertOwner(row.user_id);
  }).immediate();
}
export function telegramRecipient(userId:string) {
  const row=alertDb().prepare('SELECT * FROM price_alert_telegram WHERE user_id=? AND confirmed=1').get(userId) as Telegram|undefined;
  return row?decryptSecret(row.chat_secret,true):null;
}
export function triggerAlert(row:AlertRow,quote:Quote,now=Date.now()) {
  if(row.state!=='enabled'||!grantAlive(row.user_id,row.grant_id,now))return false;
  const rule=JSON.parse(row.config) as AlertConfig,at=tradingQuoteTime(quote.time,rule.market);
  if(quote.cached||!['futu','tencent','yahoo','auto'].includes(quote.source??'')||!quote.session||at===null||at<row.activated_at||at<=row.last_quote_at||now-at>90000||at-now>5000||!Number.isFinite(quote.price)||quote.price<=0||rule.expiresAt!==null&&rule.expiresAt<=now)return false;
  const expected={PRE:'pre',REGULAR:'regular',AFTER:'post',OVERNIGHT:'overnight'}[quote.session];
  if(!expected||marketSessionState(rule.market,new Date(at)).session!==expected||(!rule.extended&&quote.session!=='REGULAR'))return false;
  const amount=decimalMicros(quote.price.toFixed(6)),target=decimalMicros(rule.price);if(amount===null||target===null)return false;
  const local=new Intl.DateTimeFormat('en-CA',{timeZone:rule.market==='US'?'America/New_York':rule.market==='HK'?'Asia/Hong_Kong':'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at+(quote.session==='OVERNIGHT'?12*3600000:0)));
  const period=rule.frequency==='once'?'once':local,db=alertDb();
  return db.transaction(()=>{
    const current=db.prepare('SELECT * FROM price_alert_rules WHERE user_id=? AND id=? AND revision=? AND state=?').get(row.user_id,row.id,row.revision,'enabled') as AlertRow|undefined;
    if(!current||current.last_quote_at>=at||!grantAlive(row.user_id,row.grant_id,now))return false;
    db.prepare('UPDATE price_alert_rules SET last_quote_at=? WHERE user_id=? AND id=?').run(at,row.user_id,row.id);
    if(rule.direction==='above'?amount<target:amount>target)return false;
    const id=randomUUID(),data={id,grantId:row.grant_id,ruleId:row.id,name:rule.name,code:rule.code,market:rule.market,currency:{US:'USD',HK:'HKD',CN:'CNY'}[rule.market],direction:rule.direction,target:rule.price,price:quote.price,session:quote.session,quoteTime:quote.time,createdAt:now};
    const inserted=db.prepare('INSERT OR IGNORE INTO price_alert_events VALUES(?,?,?,?,?,?,?,NULL)').run(id,row.user_id,row.id,row.revision,period,JSON.stringify(data),now);
    if(!inserted.changes)return false;
    for(const channel of channelState(row.user_id).filter(c=>c.enabled&&c.ready))db.prepare('INSERT INTO price_alert_deliveries VALUES(?,?,?,?,?,?)').run(randomUUID(),row.user_id,id,channel.channel,channel.channel==='app'?'delivered':'queued',now);
    touchAlertOwner(row.user_id);
    if(rule.frequency==='once')db.prepare("UPDATE price_alert_rules SET state='completed' WHERE user_id=? AND id=?").run(row.user_id,row.id);
    return true;
  }).immediate();
}
