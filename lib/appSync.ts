import { createHash } from "node:crypto";
import { getDb } from "./db";
import { APP_CLIENT_ID, authenticateAppAccess } from "./appAuth";
import { APP_SYNC_DOMAINS, bumpAppSync, installAppSync } from "./appSyncSchema";
import { readJsonBody } from "./requestBody";
import { ok, fail } from "./api";
import { RecordsError, validRecordRequestId } from "./recordsContract";
import { rateLimit } from "./rateLimit";

const namespaces=["watch","fees"];
const domain=(namespace:string)=>namespace==="watch"?"watch":"settings";
function grant(request:Request,write=false) {
  const token=request.headers.get("authorization")?.match(/^Bearer (fat_[A-Za-z0-9_-]{43})$/)?.[1],value=token&&authenticateAppAccess(token,request);
  if(!value||value.client_id!==APP_CLIENT_ID)throw new RecordsError("连接已失效",401);
  if(!value.scope.split(" ").includes(write?"portfolio.write":"portfolio.read"))throw new RecordsError("当前连接未授权",403);
  return value;
}
function canonical(value:unknown):string { if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";return "{"+Object.keys(value as object).sort().map(key=>JSON.stringify(key)+":"+canonical((value as Record<string,unknown>)[key])).join(",")+"}"; }
function snapshot(userId:string,namespace:string) {
  const db=getDb();const rows=db.prepare("SELECT field,value,revision FROM app_state_fields WHERE user_id=? AND namespace=? ORDER BY field").all(userId,namespace) as {field:string;value:string|null;revision:number}[];
  return {version:1,userId,namespace,fields:Object.fromEntries(rows.map(row=>[row.field,{revision:row.revision,value:row.value===null?null:JSON.parse(row.value)}]))};
}
function validFeeRule(raw:unknown) {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return false;
 const r=raw as Record<string,unknown>,number=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1e12;
 if(Object.keys(r).some(key=>!["basis","rate","minimum","maximum","maximumPercent","minimumWins","side","tiers","graduated"].includes(key))||typeof r.basis!=="string"||!["free","percent","permille","share","contract","order"].includes(r.basis)||!["both","buy","sell"].includes(String(r.side))||typeof r.minimumWins!=="boolean"||typeof r.graduated!=="boolean"||!Array.isArray(r.tiers)||r.tiers.length>12)return false;
 for(const key of ["rate","minimum","maximum","maximumPercent"])if(r[key]!=null&&!number(r[key]))return false;
 if(Number(r.maximumPercent??0)>100||r.basis==="percent"&&Number(r.rate??0)>100||r.basis==="permille"&&Number(r.rate??0)>1000)return false;
 if(r.basis==="free"&&([r.rate,r.minimum,r.maximum,r.maximumPercent].some(v=>v!=null)||r.tiers.length))return false;
 let prior=-1;
 for(const [index,rawTier]of r.tiers.entries()) {
  if(!rawTier||typeof rawTier!=="object"||Array.isArray(rawTier))return false;
  const tier=rawTier as Record<string,unknown>;
  if(Object.keys(tier).sort().join(",")!=="from,rate"||!number(tier.from)||!number(tier.rate)||index===0&&tier.from!==0||Number(tier.from)<=prior||r.basis==="percent"&&Number(tier.rate)>100||r.basis==="permille"&&Number(tier.rate)>1000)return false;
  prior=Number(tier.from);
 }
 return true;
}
function validateFields(namespace:string,fields:Record<string,unknown>,userId:string) {
 if(namespace==="watch") {
  for(const [key,value] of Object.entries(fields)) {
   if(value===null)continue;let parts:unknown;try{parts=JSON.parse(key);}catch{throw new RecordsError("自选字段无效");}
   if(!Array.isArray(parts)||parts.length<2||parts.some(v=>typeof v!=="string"||!v||v.length>250))throw new RecordsError("自选字段无效");
   const root=parts[0];
   if(["hidden","pinned"].includes(root)&&parts.length===2&&value===true)continue;
   if(root==="groups"&&parts.length===3&&value===true)continue;
   if(root==="orders"&&parts.length===2&&Array.isArray(value)&&value.length<=10000&&value.every(v=>typeof v==="string"&&v.length<=250)&&new Set(value).size===value.length)continue;
   if(["notes","aliases","moved"].includes(root)&&parts.length===2&&typeof value==="string"&&value.length<=(root==="notes"?10000:250))continue;
   throw new RecordsError("自选内容无效");
  }
 } else {
  const active:{accountID:string;market:string;effectiveFrom:string;effectiveThrough?:string|null}[]=[];
  for(const [key,value] of Object.entries(fields)) {
   if(value===null)continue;
   if(typeof value!=="string"||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new RecordsError("费率内容无效");
   let plan:Record<string,unknown>;try{plan=JSON.parse(Buffer.from(value,"base64").toString("utf8"));}catch{throw new RecordsError("费率内容无效");}
   if(!plan||typeof plan!=="object"||Array.isArray(plan)||typeof plan.id!=="string"||!validDay(plan.effectiveFrom)||plan.effectiveThrough!=null&&!validDay(plan.effectiveThrough)||typeof plan.accountID!=="string"||!/^ba-[a-f0-9]{24}$/.test(plan.accountID)||!Number.isSafeInteger(plan.revision)||Number(plan.revision)<1||typeof plan.providerID!=="string"||!/^[a-z0-9-]{1,60}$/.test(plan.providerID)||typeof plan.market!=="string"||!["us","hk","cn","connect","options"].includes(plan.market)||!plan.overrides||typeof plan.overrides!=="object")throw new RecordsError("费率方案无效");
   if(!/^[0-9a-f-]{36}$/i.test(plan.id)||typeof plan.updatedAt!=="number"||!Number.isFinite(plan.updatedAt)||Array.isArray(plan.overrides)||Object.keys(plan.overrides).length>3||Object.keys(plan.overrides).some(key=>!(plan.market==="cn"?["commission","platform","fundCommission"]:["commission","platform"]).includes(key))||!Object.values(plan.overrides).every(validFeeRule)||(["cn","connect"].includes(plan.market)?plan.providerID!=="huatai":["huatai","eastmoney","ths"].includes(plan.providerID)))throw new RecordsError("费率规则无效");
   if(plan.effectiveThrough!=null&&String(plan.effectiveThrough)<String(plan.effectiveFrom))throw new RecordsError("费率期间无效");
   if(key==="plan/"+plan.id){if(!getDb().prepare("SELECT 1 FROM broker_accounts WHERE id=? AND user_id=?").get(plan.accountID,userId))throw new RecordsError("费率账户不存在",404);active.push(plan as unknown as typeof active[number]);}
   else if(key!=="history/"+plan.id+"/"+plan.revision)throw new RecordsError("费率标识无效");
  }
  if(active.length>2000)throw new RecordsError("费率方案过多");
  active.sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)if(active[i].accountID===active[j].accountID&&active[i].market===active[j].market&&(!active[i].effectiveThrough||active[i].effectiveThrough!>=active[j].effectiveFrom))throw new RecordsError("同一账户费率期间重叠",409);
 }
}
function validDay(value:unknown):value is string {if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith("0000"))return false;const date=new Date(value+"T00:00:00Z");return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
export const appSyncDiscovery=()=>({version:1,path:"/api/v2/account-sync",state_path:"/api/v2/app-state",operation_path:"/api/v2/app-state/operations/{requestId}",namespaces,domains:APP_SYNC_DOMAINS,interval_seconds:15,patch_only:true,automatic_mutation_replay:false});
export async function accountSyncResponse(request:Request) {
  return respond(()=>{const auth=grant(request),db=getDb();installAppSync(db);
    return db.transaction(()=>{grant(request);const rows=db.prepare("SELECT domain,revision FROM app_sync_revisions WHERE user_id=?").all(auth.user_id) as {domain:string;revision:number}[];
      return {version:1,userId:auth.user_id,epoch:(db.prepare("SELECT epoch FROM app_sync_metadata WHERE id=1").get() as {epoch:string}).epoch,revisions:Object.fromEntries(APP_SYNC_DOMAINS.map(domain=>[domain,rows.find(row=>row.domain===domain)?.revision??0]))};}).immediate();});
}
export async function appStateResponse(request:Request,requestId?:string) {
 return respond(async()=>{
  const initial=grant(request,request.method==="POST"),db=getDb();installAppSync(db);
  if(requestId){validRecordRequestId(requestId);const row=db.prepare("SELECT result FROM app_state_operations WHERE user_id=? AND request_id=?").get(initial.user_id,requestId) as {result:string}|undefined;if(!row)throw new RecordsError("同步回执尚未找到",404);return JSON.parse(row.result);}
  const namespace=new URL(request.url).searchParams.get("namespace")??"";
  if(request.method==="GET"){if(!namespaces.includes(namespace))throw new RecordsError("同步类别无效");return snapshot(initial.user_id,namespace);}
  if(!rateLimit(`app-state:${initial.user_id}`,120,60_000))throw new RecordsError("操作过于频繁",429);
  const body=await readJsonBody(request,1024*1024).catch(()=>null) as {requestId?:unknown;namespace?:unknown;changes?:unknown}|null;
  if(!body||Object.keys(body).some(key=>!["requestId","namespace","changes"].includes(key))||typeof body.namespace!=="string"||!namespaces.includes(body.namespace)||!Array.isArray(body.changes)||!body.changes.length||body.changes.length>1000)throw new RecordsError("同步修改无效");
  const id=validRecordRequestId(body.requestId),space=body.namespace,changes=body.changes as {key:string;revision:number;value:unknown}[];
  const keys=new Set<string>();
  for(const item of changes){if(!item||Object.keys(item).sort().join(",")!=="key,revision,value"||typeof item.key!=="string"||!item.key||item.key.length>512||/[\x00-\x1f\x7f]/.test(item.key)||["__proto__","prototype","constructor"].includes(item.key)||!Number.isSafeInteger(item.revision)||item.revision<0||keys.has(item.key)||Buffer.byteLength(canonical(item.value))>64*1024)throw new RecordsError("同步字段无效");keys.add(item.key);}
  const digest=createHash("sha256").update(canonical(body)).digest("hex");
  return db.transaction(()=>{
    const current=grant(request,true);if(current.user_id!==initial.user_id||current.id!==initial.id)throw new RecordsError("连接已变化",401);
    const prior=db.prepare("SELECT digest,result FROM app_state_operations WHERE user_id=? AND request_id=?").get(current.user_id,id) as {digest:string;result:string}|undefined;
    if(prior){if(prior.digest!==digest)throw new RecordsError("请求标识已使用",409);return JSON.parse(prior.result);}
    let conflict=false;
    for(const item of changes){const old=db.prepare("SELECT revision FROM app_state_fields WHERE user_id=? AND namespace=? AND field=?").get(current.user_id,space,item.key) as {revision:number}|undefined;if((old?.revision??0)!==item.revision)conflict=true;}
    const count=(db.prepare("SELECT COUNT(*) n FROM app_state_fields WHERE user_id=? AND namespace=?").get(current.user_id,space) as {n:number}).n;
    if(count+changes.filter(item=>item.revision===0).length>10000)throw new RecordsError("同步内容过多");
    if(!conflict){
      const fields=Object.fromEntries(Object.entries(snapshot(current.user_id,space).fields).map(([key,entry])=>[key,entry.value]));
      for(const item of changes) {
        if(space==="fees"&&item.key.startsWith("history/")&&fields[item.key]!=null&&fields[item.key]!==item.value)throw new RecordsError("历史费率证据不可覆盖",409);
        if(space==="fees"&&item.key.startsWith("plan/")&&typeof fields[item.key]==="string"&&fields[item.key]!==item.value) {
          const old=JSON.parse(Buffer.from(fields[item.key] as string,"base64").toString("utf8")) as {id:string;revision:number;accountID:string;providerID:string;market:string};
          const evidence=changes.find(change=>change.key==="history/"+old.id+"/"+old.revision)?.value??fields["history/"+old.id+"/"+old.revision];
          if(evidence!==fields[item.key])throw new RecordsError("请保留本次替换的原费率证据",409);
          if(item.value!==null) {
            const next=JSON.parse(Buffer.from(String(item.value),"base64").toString("utf8")) as typeof old;
            if(next.revision!==old.revision+1||next.accountID!==old.accountID||next.providerID!==old.providerID||next.market!==old.market)throw new RecordsError("费率身份或原版本已变化",409);
          }
        }
        fields[item.key]=item.value;
      }
      if(Buffer.byteLength(canonical(fields))>4*1024*1024)throw new RecordsError("共享内容超过当前容量");
      validateFields(space,fields,current.user_id);
      for(const item of changes)db.prepare("INSERT INTO app_state_fields(user_id,namespace,field,value,revision) VALUES(?,?,?,?,1) ON CONFLICT(user_id,namespace,field) DO UPDATE SET value=excluded.value,revision=revision+1").run(current.user_id,space,item.key,item.value===null?null:canonical(item.value));bumpAppSync(db,current.user_id,domain(space));}
    const result={requestId:id,userId:current.user_id,namespace:space,state:conflict?"conflict":"completed",code:conflict?40902:0,message:conflict?"其他设备已修改相同内容，请核对后再保存":"ok",data:{...snapshot(current.user_id,space),partial:true,fields:Object.fromEntries(Object.entries(snapshot(current.user_id,space).fields).filter(([key])=>keys.has(key)))}};
    db.prepare("INSERT INTO app_state_operations VALUES(?,?,?,?)").run(current.user_id,id,digest,JSON.stringify(result));return result;
  }).immediate();
 });
}
async function respond(operation:()=>unknown|Promise<unknown>){
 let response:Response;
 try {response=ok(await operation());}catch(error){response=fail(error instanceof RecordsError?error.code:50001,error instanceof RecordsError?error.message:"账户同步暂不可用",error instanceof RecordsError?error.status:500);}
 response.headers.set("Cache-Control","private, no-store");response.headers.set("Vary","Authorization");return response;
}
