import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getDb } from "./db";
import presets from "./brokerPresets.json";
import { DEFAULT_GROUPS } from "./settings";
import { collectionRevision, RecordsError, validRecordRequestId } from "./recordsContract";
import { isFundCurrency } from "./fundCurrencies";
import { listRecords, updateRecord } from "./store";

type Row = {id:string;user_id:string;name:string;provider_id:string|null;currency:string;revision:number;icon:Buffer|null;created_at:string;updated_at:string};
export type BrokerKind = "create"|"update"|"delete"|"upload_icon"|"reset_icon"|"bind_records";
export function brokerPresets() {
  const icons = getDb().prepare("SELECT code,name,url,updated_at FROM assets WHERE type='broker'").all() as {code:string;name:string;url:string;updated_at:string}[];
  return presets.map(p => {
    const names = [p.id,p.name,...p.aliases].map(n=>n.toLowerCase().replace(/证劵/g,"证券"));
    const match = icons.find(i=>names.includes(i.code.toLowerCase())||names.includes(i.name.toLowerCase().replace(/证劵/g,"证券")));
    const icon = match?.url;
    let safe:string|null=null;
    if(icon?.startsWith("/uploads/"))try {
      const decoded=decodeURIComponent(icon);
      if(!decoded.includes("\\")&&!/[?#\x00-\x1f]/.test(decoded)&&!decoded.split('/').some(part=>part==='..'||part==='.')&&existsSync(path.join(process.cwd(),'public',decoded)))safe=icon+`?v=${encodeURIComponent(match!.updated_at)}`;
    }catch { /* Invalid or absent source icon stays unavailable. */ }
    return {...p,icon:safe ?? (existsSync(path.join(process.cwd(),"public/broker-presets",`${p.id}.jpg`)) ? `/broker-presets/${p.id}.jpg` : null)};
  });
}
function row(userId:string,id:string) {
  return getDb().prepare("SELECT * FROM broker_accounts WHERE user_id=? AND id=?").get(userId,id) as Row|undefined;
}
export function brokerAccount(userId:string,id:string,version:1|2) {
  const r=row(userId,id);if(!r)throw new RecordsError("账户不存在",404);
  const preset=brokerPresets().find(p=>p.id===r.provider_id);
  const count=getDb().prepare("SELECT COUNT(*) n FROM records WHERE user_id=? AND broker_account_id=?").get(userId,r.id) as {n:number};
  return {id:r.id,name:r.name,providerId:r.provider_id,currency:r.currency,revision:r.revision,
    icon:r.icon?`/api/v${version}/broker-accounts/${r.id}/icon`:preset?.icon??null,
    iconSource:r.icon?"custom":preset?"preset":"none",recordGroup:r.name,recordCount:count.n,createdAt:r.created_at,updatedAt:r.updated_at};
}
export function brokerAccountList(userId:string,version:1|2) {
  const ids=getDb().prepare("SELECT id FROM broker_accounts WHERE user_id=? ORDER BY created_at,id").all(userId) as {id:string}[];
  const rev=getDb().prepare("SELECT revision FROM broker_account_collections WHERE user_id=?").get(userId) as {revision:number}|undefined;
  return {accountId:userId,items:ids.map(r=>brokerAccount(userId,r.id,version)),collectionRevision:rev?.revision??0};
}
export function brokerIcon(userId:string,id:string) {const r=row(userId,id);if(!r?.icon)throw new RecordsError("图标不存在",404);return r.icon;}
export function brokerOperation(userId:string,requestId:string) {
  validRecordRequestId(requestId);
  const r=getDb().prepare("SELECT result_json FROM broker_account_operations WHERE user_id=? AND request_id=?").get(userId,requestId) as {result_json:string}|undefined;
  if(!r)throw new RecordsError("回执不存在",404);return JSON.parse(r.result_json);
}
function integer(value:unknown) {return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function nameAvailable(userId:string,name:string,id:string) {
  const names=getDb().prepare("SELECT name FROM broker_accounts WHERE user_id=? AND id!=?").all(userId,id) as {name:string}[];
  if(names.some(r=>r.name.toLowerCase()===name.toLowerCase()))throw new RecordsError("账户名称已使用",409,40902);
  // A global label must not silently become a personal account or vice versa.
  const stored=getDb().prepare("SELECT value FROM site_settings WHERE key='groups'").get() as {value:string}|undefined;
  let shared:unknown;
  try{shared=stored?JSON.parse(stored.value):DEFAULT_GROUPS;}catch{throw new RecordsError("共享目录暂时无法核对",500);}
  if(!Array.isArray(shared)||shared.some(g=>!g||typeof g.name!=='string'||g.alias!==undefined&&typeof g.alias!=='string'))throw new RecordsError("共享目录暂时无法核对",500);
  if(shared.some(g=>[g.name,g.alias].some(n=>typeof n==='string'&&n.toLowerCase()===name.toLowerCase())))throw new RecordsError("请使用区别于共享券商名称的个人账户名称",409,40902);
  const groups=getDb().prepare("SELECT DISTINCT group_name name FROM records WHERE user_id=? AND group_name!=COALESCE((SELECT name FROM broker_accounts WHERE user_id=? AND id=?),'')").all(userId,userId,id) as {name:string}[];
  if(groups.some(r=>r.name.toLowerCase()===name.toLowerCase()))throw new RecordsError("已有记录使用该名称，请选择独立账户名称",409,40902);
}
export function mutateBroker(userId:string,kind:BrokerKind,id:string,raw:unknown,version:1|2,authorize:()=>string,icon?:Buffer) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new RecordsError("无效请求");
  const b=raw as Record<string,unknown>,requestId=validRecordRequestId(b.requestId);
  const fields=kind==='bind_records'?['requestId','revision','recordCollectionRevision','recordIds',...('allowReassign' in b?['allowReassign']:[])]:kind==='create'?['requestId','name','providerId','currency']:kind==='update'?['requestId','revision','name','currency','recordCollectionRevision']:['requestId','revision'];
  if(Object.keys(b).some(k=>!fields.includes(k))||fields.some(k=>!(k in b)))throw new RecordsError("请求字段无效");
  if(kind!=='create'&&!integer(b.revision))throw new RecordsError("账户版本无效");
  let name='',currency='';
  if(kind==='create'||kind==='update') {
    if(typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>60||/[\x00-\x1f\x7f]/.test(b.name)||typeof b.currency!=='string'||!isFundCurrency(b.currency))throw new RecordsError("名称或币种无效");
    name=b.name.trim();currency=b.currency;
  }
  if(kind==='create'&&b.providerId!==null&&!presets.some(p=>p.id===b.providerId))throw new RecordsError("机构无效");
  if((kind==='update'||kind==='bind_records')&&!integer(b.recordCollectionRevision))throw new RecordsError("记录集合版本无效");
  if(kind==='bind_records'&&(!Array.isArray(b.recordIds)||!b.recordIds.length||b.recordIds.length>2000||b.recordIds.some(x=>typeof x!=='string'||!/^r-[a-f0-9]{16}$/.test(x))||new Set(b.recordIds).size!==b.recordIds.length))throw new RecordsError('持仓选择无效');
  if(kind==='upload_icon'&&(!icon||icon.length>2097152))throw new RecordsError("图标无效");
  const db=getDb();
  return db.transaction(()=>{
    if(authorize()!==userId)throw new RecordsError("连接已变化",401);
    if(db.prepare("SELECT 1 FROM broker_account_operations WHERE user_id=? AND request_id=?").get(userId,requestId))throw new RecordsError("重复请求，请查询原回执",409,40901);
    let accountId=id,data:ReturnType<typeof brokerAccount>|null=null,error:RecordsError|null=null;
    try {db.transaction(()=>{
      const current=kind==='create'?undefined:row(userId,id);
      if(kind!=='create'&&!current)throw new RecordsError("账户不存在",404);
      if(current&&current.revision!==b.revision)throw new RecordsError("账户已变化",409,40902);
      const at=new Date().toISOString();
      if(kind==='create') {
        const count=db.prepare("SELECT COUNT(*) n FROM broker_accounts WHERE user_id=?").get(userId) as {n:number};
        if(count.n>=100)throw new RecordsError("账户数已达上限",409,40902);
        nameAvailable(userId,name,'');accountId='ba-'+randomBytes(12).toString('hex');
        db.prepare("INSERT INTO broker_accounts(id,user_id,name,provider_id,currency,revision,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)").run(accountId,userId,name,b.providerId,currency,at,at);
      } else if(kind==='update') {
        if(collectionRevision(userId)!==b.recordCollectionRevision)throw new RecordsError("持仓记录已变化",409,40902);
        nameAvailable(userId,name,id);
        db.prepare("UPDATE broker_accounts SET name=? WHERE user_id=? AND id=?").run(name,userId,id);
        if(current!.name!==name)for(const r of listRecords(userId).filter(r=>r.brokerAccountId===id)) {
          if(!updateRecord(r.id,userId,{...r,group:name}))throw new Error('record update failed');
        }
        db.prepare("UPDATE broker_accounts SET name=?,currency=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=?").run(name,currency,at,userId,id);
      } else if(kind==='bind_records') {
        if(collectionRevision(userId)!==b.recordCollectionRevision)throw new RecordsError('持仓记录已变化',409,40902);
        const chosen=listRecords(userId).filter(r=>(b.recordIds as string[]).includes(r.id));
        if(chosen.length!==(b.recordIds as string[]).length)throw new RecordsError('持仓不存在',404);
        if(b.allowReassign!==undefined&&typeof b.allowReassign!=='boolean')throw new RecordsError('归属调整确认无效');
        if(b.allowReassign!==true&&chosen.some(r=>r.brokerAccountId&&r.brokerAccountId!==id))throw new RecordsError('已关联其他账户的持仓须通过转仓处理',409,40902);
        const keys=new Set<string>();
        for(const r of [...listRecords(userId).filter(r=>r.brokerAccountId===id&&!chosen.some(c=>c.id===r.id)),...chosen]) {
          const key=JSON.stringify([r.market,r.code,r.accountMarket??'']);
          if(keys.has(key))throw new RecordsError('同一账户存在重复证券，请先处理',409,40902);keys.add(key);
        }
        for(const r of chosen)updateRecord(r.id,userId,{...r,brokerAccountId:id,group:current!.name});
        db.prepare('UPDATE broker_accounts SET revision=revision+1,updated_at=? WHERE user_id=? AND id=?').run(at,userId,id);
      } else if(kind==='delete') {
        if(db.prepare('SELECT 1 FROM broker_statement_imports WHERE user_id=? AND account_id=?').get(userId,id))throw new RecordsError('账户含官方账单历史，不能直接删除',409,40902);
        if(db.prepare("SELECT 1 FROM records WHERE user_id=? AND broker_account_id=?").get(userId,id))throw new RecordsError("账户仍有关联记录",409,40902);
        db.prepare("DELETE FROM broker_accounts WHERE user_id=? AND id=?").run(userId,id);
      } else db.prepare("UPDATE broker_accounts SET icon=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=?").run(kind==='upload_icon'?icon!:null,at,userId,id);
      if(kind!=='delete')data=brokerAccount(userId,accountId,version);
      db.prepare("INSERT INTO broker_account_collections(user_id,revision) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1").run(userId);
    })();}catch(e){if(!(e instanceof RecordsError))throw e;error=e;data=null;}
    const result={requestId,kind,accountId,state:error?'failed':'completed',code:error?.code??0,message:error?.message??'ok',completedAt:new Date().toISOString(),data};
    db.prepare("INSERT INTO broker_account_operations(user_id,request_id,result_json) VALUES(?,?,?)").run(userId,requestId,JSON.stringify(result));
    return {result,error};
  }).immediate();
}
