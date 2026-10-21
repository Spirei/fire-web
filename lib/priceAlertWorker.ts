import { randomUUID } from 'node:crypto';
import { alertDb, alertsAvailable, triggerAlert, touchAlertOwner, grantAlive, telegramConfigured, telegramRecipient, receiveTelegram, channelState, type AlertRow } from './priceAlerts';
import { telegramBotToken } from './socialChannels';
import { fetchOverviewQuotes } from './quotes';
import { sendPriceAlertEmail } from './mail';
import { MailBudgetError } from './mailBudget';

type Delivery={id:string;user_id:string;event_id:string;channel:string;data:string;rule_revision:number};
const owner=randomUUID();
const globalWorker=globalThis as typeof globalThis & {__alcorPriceAlertTimer?:ReturnType<typeof setInterval>};
let working=false;
async function telegram(method:'getUpdates'|'sendMessage',body:unknown) {
  const token=telegramBotToken();
  if(!telegramConfigured())throw new Error('Telegram未配置');
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000),cache:'no-store'});
  if(!response.ok)throw new Error('Telegram未确认请求');
  const data=await response.json() as {ok?:boolean;result?:unknown};
  if(data.ok!==true)throw new Error('Telegram未确认请求');return data.result;
}
async function pollTelegram() {
  if(!telegramConfigured())return;
  const db=alertDb(),offset=(db.prepare("SELECT value FROM price_alert_worker_state WHERE id='telegram_offset'").get() as {value:number}|undefined)?.value??0;
  const result=await telegram('getUpdates',{offset,timeout:0,limit:100,allowed_updates:['message']});
  if(!Array.isArray(result))return;
  for(const update of result){
    if(!update||!Number.isSafeInteger(update.update_id)||update.update_id<offset)continue;
    receiveTelegram(update);
    db.prepare("INSERT INTO price_alert_worker_state VALUES('telegram_offset',?) ON CONFLICT(id) DO UPDATE SET value=MAX(value,excluded.value)").run(update.update_id+1);
  }
}
export function eventText(event:Record<string,unknown>) {
  if(event.kind==='test')return 'Alcor 通知测试\n这是一条由你主动发起的测试通知。';
  const session=({PRE:'盘前',REGULAR:'盘中',AFTER:'盘后',OVERNIGHT:'夜盘'} as Record<string,string>)[String(event.session)]||'时段未知';
  return `${event.name} (${event.code})\n${event.direction==='above'?'涨至':'跌至'} ${event.target} ${event.currency}\n触达价格 ${event.price} · ${session}\n行情时间 ${event.quoteTime}`;
}
async function dispatch(delivery:Delivery) {
  const db=alertDb(),event=JSON.parse(delivery.data) as Record<string,unknown>;
  const ready=channelState(delivery.user_id).find(c=>c.channel===delivery.channel);
  const rule=event.ruleId?db.prepare('SELECT * FROM price_alert_rules WHERE user_id=? AND id=?').get(delivery.user_id,event.ruleId) as AlertRow|undefined:undefined;
  if(!ready?.ready||event.kind!=='test'&&(!ready.enabled||!rule||rule.revision!==delivery.rule_revision||!['enabled','completed'].includes(rule.state))||!grantAlive(delivery.user_id,String(event.grantId))) {
    db.prepare("UPDATE price_alert_deliveries SET state='cancelled',updated_at=? WHERE id=? AND state='queued'").run(Date.now(),delivery.id);touchAlertOwner(delivery.user_id);return;
  }
  const claim=db.prepare("UPDATE price_alert_deliveries SET state='sending',updated_at=? WHERE id=? AND state='queued'").run(Date.now(),delivery.id);
  if(!claim.changes)return;touchAlertOwner(delivery.user_id);
  // Never resend after unknown acceptance. A crash/timeout may already have delivered.
  try {
    if(delivery.channel==='email') {
      const user=db.prepare('SELECT email FROM users WHERE id=?').get(delivery.user_id) as {email:string};
      await sendPriceAlertEmail(user.email,event);
    } else if(delivery.channel==='telegram') {
      const chat=telegramRecipient(delivery.user_id);if(!chat)throw new Error('Telegram绑定已失效');
      const result=await telegram('sendMessage',{chat_id:chat,text:eventText(event),protect_content:true});
      if(!result||typeof result!=='object'||!Number.isSafeInteger((result as {message_id?:number}).message_id))throw new Error('Telegram未确认接收');
    } else throw new Error('不支持的通知方式');
    db.prepare("UPDATE price_alert_deliveries SET state='accepted',updated_at=? WHERE id=? AND state='sending'").run(Date.now(),delivery.id);touchAlertOwner(delivery.user_id);
  } catch(error) {
    db.prepare("UPDATE price_alert_deliveries SET state=?,updated_at=? WHERE id=? AND state='sending'").run(error instanceof MailBudgetError ? 'failed' : 'unknown',Date.now(),delivery.id);touchAlertOwner(delivery.user_id);
  }
}
export async function priceAlertTick() {
  if(working||!alertsAvailable())return;
  const db=alertDb(),now=Date.now();
  const acquired=db.transaction(()=>{
    db.prepare("INSERT OR IGNORE INTO price_alert_worker_lease VALUES(1,'',0)").run();
    return db.prepare('UPDATE price_alert_worker_lease SET owner=?,until_at=? WHERE id=1 AND until_at<=?').run(owner,now+60000,now).changes;
  }).immediate();
  if(!acquired)return;working=true;
  try {
    try { await pollTelegram(); } catch { /* Binding remains pending; no credential details enter logs. */ }
    const rows=db.prepare("SELECT * FROM price_alert_rules WHERE state='enabled' ORDER BY last_scan_at,id LIMIT 100").all() as AlertRow[];
    const current:AlertRow[]=[];
    for(const row of rows) {
      const config=JSON.parse(row.config);
      if(!grantAlive(row.user_id,row.grant_id)) {db.prepare("UPDATE price_alert_rules SET state='paused',revision=revision+1 WHERE user_id=? AND id=? AND revision=?").run(row.user_id,row.id,row.revision);touchAlertOwner(row.user_id);continue;}
      if(config.expiresAt!==null&&config.expiresAt<=Date.now()) {db.prepare("UPDATE price_alert_rules SET state='expired',revision=revision+1 WHERE user_id=? AND id=? AND revision=?").run(row.user_id,row.id,row.revision);touchAlertOwner(row.user_id);continue;}
      db.prepare('UPDATE price_alert_rules SET last_scan_at=? WHERE user_id=? AND id=?').run(Date.now(),row.user_id,row.id);current.push(row);
    }
    if(current.length) {
      const items=current.map(row=>{const c=JSON.parse(row.config);return{id:row.user_id+':'+row.id,market:c.market,code:c.code};});
      const snapshot=await fetchOverviewQuotes(items,1500);
      for(const row of current){const key=row.user_id+':'+row.id,quote=snapshot.quotes[key];if(quote&&!snapshot.cached.includes(key))triggerAlert(row,quote);}
    }
    db.prepare("UPDATE price_alert_deliveries SET state='unknown' WHERE state='sending' AND updated_at<?").run(Date.now()-120000);
    const deliveries=db.prepare("SELECT d.*,e.data,e.rule_revision FROM price_alert_deliveries d JOIN price_alert_events e ON e.id=d.event_id AND e.user_id=d.user_id WHERE d.state='queued' ORDER BY d.updated_at LIMIT 10").all() as Delivery[];
    for(const delivery of deliveries) {
      const lease=db.prepare('SELECT 1 FROM price_alert_worker_lease WHERE id=1 AND owner=? AND until_at>?').get(owner,Date.now());
      if(!lease)break;await dispatch(delivery);
    }
  } finally {
    working=false;db.prepare('UPDATE price_alert_worker_lease SET until_at=0 WHERE id=1 AND owner=?').run(owner);
  }
}
export function startPriceAlertWorker() {
  if(globalWorker.__alcorPriceAlertTimer||!alertsAvailable())return;
  globalWorker.__alcorPriceAlertTimer=setInterval(()=>{void priceAlertTick().catch(()=>{});},5000);
  globalWorker.__alcorPriceAlertTimer.unref();
}
