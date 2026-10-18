import { createHash } from 'node:crypto';
import { getDb } from './db';
import { RecordsError,validRecordRequestId } from './recordsContract';
import type Database from 'better-sqlite3';
export function installPersonalProfile(db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS personal_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL,bio TEXT NOT NULL DEFAULT '',gender TEXT NOT NULL DEFAULT 'unspecified',background BLOB,initialized TEXT NOT NULL DEFAULT '[]');CREATE TABLE IF NOT EXISTS personal_profile_operations(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,request_id));`);}
type Row={revision:number;bio:string;gender:string;background:Buffer|null;initialized:string};
function row(id:string){return getDb().prepare('SELECT * FROM personal_profiles WHERE user_id=?').get(id) as Row|undefined;}
export function personalProfile(id:string,version:1|2){const r=row(id);return {userId:id,revision:r?.revision??0,bio:r?.bio??'',gender:r?.gender??'unspecified',background:r?.background?{path:`/api/v${version}/personal-profile/background`,sha256:createHash('sha256').update(r.background).digest('hex')}:null,initializedFields:r?JSON.parse(r.initialized) as string[]:[]};}
export function personalBackground(id:string){const bytes=row(id)?.background;if(!bytes)throw new RecordsError('背景图不存在',404);return bytes;}
export function personalOperation(id:string,requestId:string){validRecordRequestId(requestId);const r=getDb().prepare('SELECT result FROM personal_profile_operations WHERE user_id=? AND request_id=?').get(id,requestId) as {result:string}|undefined;if(!r)throw new RecordsError('回执不存在',404);return JSON.parse(r.result);}
export function mutatePersonalProfile(id:string,raw:unknown,version:1|2,authorize:()=>string,background?:Buffer){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecordsError('请求无效');const b=raw as Record<string,unknown>,requestId=validRecordRequestId(b.requestId);
 const upload=background!==undefined;
 if(Object.keys(b).some(k=>!['requestId','revision','changes','migration'].includes(k))||!Number.isSafeInteger(b.revision)||Number(b.revision)<0||b.migration!==undefined&&typeof b.migration!=='boolean')throw new RecordsError('版本或迁移参数无效');
 const changes=upload?{background:background}:b.changes;
 if(!changes||typeof changes!=='object'||Array.isArray(changes))throw new RecordsError('请提交明确修改的字段');
 const patch=changes as Record<string,unknown>,keys=Object.keys(patch);if(!keys.length||keys.some(k=>!['bio','gender','background'].includes(k)))throw new RecordsError('资料字段无效');
 if('bio' in patch&&(typeof patch.bio!=='string'||Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(patch.bio)).length>160||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(patch.bio)))throw new RecordsError('简介最多160个字符');
 if('gender' in patch&&!['unspecified','male','female'].includes(String(patch.gender)))throw new RecordsError('性别值无效');
 if(!upload&&'background' in patch&&patch.background!==null)throw new RecordsError('背景图须通过上传接口保存');
 const db=getDb();return db.transaction(()=>{
  if(authorize()!==id)throw new RecordsError('连接已变化',401);
  if(db.prepare('SELECT 1 FROM personal_profile_operations WHERE user_id=? AND request_id=?').get(id,requestId))throw new RecordsError('重复请求，请查询原回执',409,40901);
  let error:RecordsError|null=null,data:ReturnType<typeof personalProfile>|null=null;
  try{data=db.transaction(()=>{const old=row(id),initialized=old?JSON.parse(old.initialized) as string[]:[];
   if((old?.revision??0)!==b.revision)throw new RecordsError('资料已在其他设备修改，请重新读取',409,40902);
   if(b.migration&&keys.some(k=>initialized.includes(k)))throw new RecordsError('远端已有资料，请保留本机副本并选择',409,40902);
   db.prepare('INSERT INTO personal_profiles(user_id,revision,bio,gender,background,initialized) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,bio=excluded.bio,gender=excluded.gender,background=excluded.background,initialized=excluded.initialized').run(id,(old?.revision??0)+1,'bio' in patch?patch.bio:old?.bio??'','gender' in patch?patch.gender:old?.gender??'unspecified','background' in patch?patch.background:old?.background??null,JSON.stringify([...new Set([...initialized,...keys])]));return personalProfile(id,version);
  })();}catch(e){if(!(e instanceof RecordsError))throw e;error=e;}
  const result={requestId,kind:upload?'upload_background':'update_profile',userId:id,state:error?'failed':'completed',code:error?.code??0,message:error?.message??'ok',completedAt:new Date().toISOString(),data};
  db.prepare('INSERT INTO personal_profile_operations(user_id,request_id,result) VALUES(?,?,?)').run(id,requestId,JSON.stringify(result));return {result,error};
 }).immediate();
}
export function personalProfileDiscovery(version:1|2){const base=`/api/v${version}/personal-profile`;return {version:1,path:base,background_path:`${base}/background`,operation_path:`${base}/operations/{requestId}`,read_scope:'portfolio.read',write_scope:'profile.write',bio_max_graphemes:160,background:{content_types:['image/jpeg'],max_bytes:8388608,max_dimension:2048},patch_only:true,automatic_mutation_replay:false};}
