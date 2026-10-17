import { createHash, randomBytes } from 'node:crypto';
import { getDb } from './db';
import { RecordsError, collectionRevision, validRecordRequestId } from './recordsContract';
import { brokerAccount } from './brokerAccounts';
import { listRecords, createRecord, updateRecord } from './store';
import { encryptSecret, decryptSecret } from './secretStorage';
import { type FlexStatement } from './ibkrFlex';
import { statementAdapter,type StatementCredentials } from './brokerStatementAdapters';

const now=()=>new Date().toISOString();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const fail=(s:string,status=400):never=>{throw new RecordsError(s,status);};
function account(userId:string,id:string){return brokerAccount(userId,id,2);}
type Connection={secret:string;revision:number;reference:string|null;reference_at:string|null};
function connection(userId:string,id:string){return getDb().prepare('SELECT secret,revision,reference,reference_at FROM broker_connections WHERE user_id=? AND account_id=?').get(userId,id) as Connection|undefined;}
function config(c:Connection){return JSON.parse(decryptSecret(c.secret,true)) as StatementCredentials;}
export function statementStatus(userId:string,id:string){account(userId,id);const c=connection(userId,id);const latest=getDb().prepare('SELECT to_date,cash_json,imported_at FROM broker_statement_imports WHERE user_id=? AND account_id=? ORDER BY to_date DESC LIMIT 1').get(userId,id) as {to_date:string;cash_json:string;imported_at:string}|undefined;return {configured:!!c,connectorId:c?(config(c).connectorId??'ibkr-flex'):null,latest:latest?{toDate:latest.to_date,cash:JSON.parse(latest.cash_json),importedAt:latest.imported_at}:null};}
function mutate(userId:string,id:string,body:Record<string,unknown>,kind:string,authorize:()=>string,run:()=>unknown){
  const requestId=validRecordRequestId(body.requestId),db=getDb();
  if(!Number.isSafeInteger(body.revision)||Number(body.revision)<1)fail('账户版本无效');
  return db.transaction(()=>{
    if(authorize()!==userId)fail('连接已变化',401);
    if(db.prepare('SELECT 1 FROM broker_account_operations WHERE user_id=? AND request_id=?').get(userId,requestId))fail('重复请求，请查询原回执',409);
    const a=account(userId,id);if(a.revision!==body.revision)fail('账户已变化，请重新读取',409);
    const data=run(),completedAt=now();
    db.prepare('UPDATE broker_accounts SET revision=revision+1,updated_at=? WHERE user_id=? AND id=?').run(completedAt,userId,id);
    db.prepare('INSERT INTO broker_account_collections(user_id,revision) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1').run(userId);
    const result={requestId,kind,accountId:id,state:'completed',code:0,message:'ok',completedAt,data};
    db.prepare('INSERT INTO broker_account_operations(user_id,request_id,result_json) VALUES(?,?,?)').run(userId,requestId,JSON.stringify(result));return result;
  }).immediate();
}
export function saveFlexConnection(userId:string,id:string,b:Record<string,unknown>,authorize:()=>string){
  const adapter=statementAdapter(typeof b.connectorId==='string'?b.connectorId:'ibkr-flex');
  const credentials=adapter.credentials(b);
  return mutate(userId,id,b,'configure_statement',authorize,()=>{
    const old=getDb().prepare('SELECT external_account FROM broker_statement_imports WHERE user_id=? AND account_id=? LIMIT 1').get(userId,id) as {external_account:string}|undefined;
    if(old&&old.external_account!==b.externalAccount)fail('已有账单的账户不能改绑其他IBKR账户',409);
    const secret=encryptSecret(JSON.stringify(credentials));
    getDb().prepare('INSERT INTO broker_connections(account_id,user_id,secret) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET secret=excluded.secret,reference=NULL,reference_at=NULL,revision=broker_connections.revision+1').run(id,userId,secret);
    return {configured:true};
  });
}
export function deleteFlexConnection(userId:string,id:string,b:Record<string,unknown>,authorize:()=>string){return mutate(userId,id,b,'disconnect_statement',authorize,()=>{getDb().prepare('DELETE FROM broker_connections WHERE user_id=? AND account_id=?').run(userId,id);return {configured:false};});}
function storedPreview(userId:string,id:string,previewId:string){
  const row=getDb().prepare('SELECT * FROM broker_statement_previews WHERE id=? AND user_id=? AND account_id=?').get(previewId,userId,id) as {id:string;payload:string;digest:string;account_revision:number;record_revision:number;created_at:string}|undefined;
  if(!row)fail('预览不存在',404);if(Date.now()-Date.parse(row!.created_at)>86400000)fail('预览已过期，请重新读取',409);return row!;
}
function differences(userId:string,id:string,statement:FlexStatement){
  const all=listRecords(userId),bound=all.filter(r=>r.brokerAccountId===id),keys=new Set<string>();
  for(const r of bound){if(r.qty!==''&&(!Number.isFinite(Number(r.qty))||Number(r.qty)<0))fail('账户包含无法核对的持仓数量',422);const k=r.market+':'+r.code;if(keys.has(k))fail('账户内有重复证券，请先处理',409);keys.add(k);if(!['US','HK','CN'].includes(r.market))fail('账户中包含暂不支持的证券，请单独处理',422);}
  const rows=statement.positions.map(p=>{const old=bound.find(r=>r.market===p.market&&r.code===p.code);return {...p,recordId:old?.id??null,before:old?{qty:old.qty,cost:old.cost,price:old.price}:null,action:old?'update':'create',unassignedMatches:all.filter(r=>!r.brokerAccountId&&r.market===p.market&&r.code===p.code).map(r=>r.id)};});
  const missing=bound.filter(r=>!statement.positions.some(p=>p.market===r.market&&p.code===r.code)&&Number(r.qty)>0).map(r=>({recordId:r.id,code:r.code,market:r.market,before:r.qty,after:0}));
  return {rows,missing,requiresUnassignedAcknowledgement:rows.some(r=>r.unassignedMatches.length>0)};
}
export function prepareFlexPreview(userId:string,id:string,text:string,externalAccount:string,authorize:()=>string,connectorId='ibkr-flex'){
  const parsed=statementAdapter(connectorId).parse(text,externalAccount),db=getDb(),digest=hash(JSON.stringify(parsed));
  return db.transaction(()=>{
    if(authorize()!==userId)fail('连接已变化',401);const a=account(userId,id);
    const c=connection(userId,id);if(c&&(config(c).externalAccount!==externalAccount||(config(c).connectorId??'ibkr-flex')!==connectorId))fail('账单与已配置的IBKR账户不匹配',409);
    const imported=db.prepare('SELECT 1 FROM broker_statement_imports WHERE user_id=? AND account_id=? AND digest=?').get(userId,id,digest);
    if(imported)return {alreadyImported:true,digest};
    const last=db.prepare('SELECT to_date,external_account FROM broker_statement_imports WHERE user_id=? AND account_id=? ORDER BY to_date DESC LIMIT 1').get(userId,id) as {to_date:string;external_account:string}|undefined;
    if(last&&(last.external_account!==externalAccount||last.to_date>=parsed.toDate))fail('账户不匹配，或报表不晚于已导入快照',409);
    const diff=differences(userId,id,parsed),previewId='bsp-'+randomBytes(16).toString('hex');
    db.prepare('DELETE FROM broker_statement_previews WHERE user_id=? AND (created_at<? OR account_id=?)').run(userId,new Date(Date.now()-86400000).toISOString(),id);
    db.prepare('INSERT INTO broker_statement_previews(id,user_id,account_id,digest,payload,account_revision,record_revision,created_at) VALUES(?,?,?,?,?,?,?,?)').run(previewId,userId,id,digest,JSON.stringify(parsed),a.revision,collectionRevision(userId),now());
    return {alreadyImported:false,previewId,digest,accountRevision:a.revision,collectionRevision:collectionRevision(userId),toDate:parsed.toDate,fromDate:parsed.fromDate,cash:parsed.cash,eventCount:parsed.events.length,warnings:parsed.warnings,...diff};
  }).immediate();
}
export async function fetchFlexPreview(userId:string,id:string,authorize:()=>string){
  account(userId,id);const c=connection(userId,id);if(!c)fail('请先配置IBKR Flex读取');const cfg=config(c!);
  const reference=c!.reference&&c!.reference_at&&Date.now()-Date.parse(c!.reference_at)<3600000?c!.reference:undefined;
  const result=await statementAdapter(cfg.connectorId??'ibkr-flex').fetch(cfg,reference);
  return getDb().transaction(()=>{
    if(authorize()!==userId)fail('连接已变化',401);const current=connection(userId,id);
    if(!current||current.revision!==c!.revision)fail('读取配置已变化，请重新读取',409);
    if(result.pending){getDb().prepare('UPDATE broker_connections SET reference=?,reference_at=?,revision=revision+1 WHERE account_id=? AND user_id=?').run(result.reference,now(),id,userId);return {pending:true,retryAfterSeconds:15};}
    const preview=prepareFlexPreview(userId,id,result.xml,cfg.externalAccount,authorize,cfg.connectorId??'ibkr-flex');
    getDb().prepare('UPDATE broker_connections SET reference=NULL,reference_at=NULL,revision=revision+1 WHERE user_id=? AND account_id=?').run(userId,id);return {pending:false,...preview};
  }).immediate();
}
export function applyFlexPreview(userId:string,id:string,b:Record<string,unknown>,authorize:()=>string){
  if(typeof b.previewId!=='string'||!/^bsp-[a-f0-9]{32}$/.test(b.previewId))fail('预览ID无效');
  return mutate(userId,id,b,'import_statement',authorize,()=>{
    const db=getDb(),preview=storedPreview(userId,id,b.previewId as string),statement=JSON.parse(preview.payload) as FlexStatement,a=account(userId,id);
    if(a.revision!==preview.account_revision||collectionRevision(userId)!==preview.record_revision)fail('预览后账户或持仓已变化，请重新预览',409);
    if(db.prepare('SELECT 1 FROM broker_statement_imports WHERE user_id=? AND account_id=? AND digest=?').get(userId,id,preview.digest))fail('账单已导入',409);
    const diff=differences(userId,id,statement);if(diff.requiresUnassignedAcknowledgement&&b.acknowledgeUnassigned!==true)fail('存在同证券未绑定持仓，请先绑定或确认分开记录',409);
    if(db.prepare("SELECT 1 FROM trade_orders o JOIN records r ON r.id=o.record_id AND r.user_id=o.user_id WHERE r.user_id=? AND r.broker_account_id=? AND o.status='pending' LIMIT 1").get(userId,id))fail('账户仍有待成交订单，请完成或取消后再核对账单',409);
    const newer=db.prepare("SELECT 1 FROM trade_orders o JOIN records r ON r.id=o.record_id AND r.user_id=o.user_id WHERE r.user_id=? AND r.broker_account_id=? AND replace(substr(o.traded_at,1,10),'-','')>? LIMIT 1").get(userId,id,statement.toDate);
    if(newer)fail('账户已有晚于账单的订单，请读取更新账单',409);
    for(const e of statement.events){const payload=JSON.stringify(e),old=db.prepare('SELECT payload FROM broker_statement_events WHERE user_id=? AND account_id=? AND external_id=?').get(userId,id,e.id) as {payload:string}|undefined;if(old&&old.payload!==payload)fail('官方流水已更正，请核对后处理',409);db.prepare('INSERT OR IGNORE INTO broker_statement_events(user_id,account_id,external_id,payload) VALUES(?,?,?,?)').run(userId,id,e.id,payload);}
    for(const p of diff.rows){const input={name:p.name,code:p.code,market:p.market,price:p.price,cost:p.cost,qty:p.qty,group:a.name,brokerAccountId:id,note:'',source:'ibkr-flex'};if(p.recordId){const r=listRecords(userId).find(r=>r.id===p.recordId)!;updateRecord(r.id,userId,{...input,note:r.note,watchGroupId:r.watchGroupId});}else createRecord(userId,input);}
    for(const m of diff.missing){const r=listRecords(userId).find(r=>r.id===m.recordId)!;updateRecord(r.id,userId,{...r,qty:0});}
    db.prepare('INSERT INTO broker_statement_imports(user_id,account_id,digest,to_date,external_account,cash_json,imported_at) VALUES(?,?,?,?,?,?,?)').run(userId,id,preview.digest,statement.toDate,statement.externalAccount,JSON.stringify(statement.cash),now());
    db.prepare('DELETE FROM broker_statement_previews WHERE user_id=? AND account_id=?').run(userId,id);
    return {digest:preview.digest,updated:diff.rows.filter(p=>p.recordId).length,created:diff.rows.filter(p=>!p.recordId).length,closed:diff.missing.length,eventCount:statement.events.length,collectionRevision:collectionRevision(userId)};
  });
}
