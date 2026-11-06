import sharp from "sharp";
import { getDb } from "./db";
import { brokerRequestAuth } from "./brokerRequestAuth";
import { fail, ok } from "./api";
import { readFormBody, readJsonBody, RequestBodyTooLargeError } from "./requestBody";
import { RecordsError } from "./recordsContract";
import { brokerAccount, brokerAccountList, brokerIcon, brokerOperation, brokerPresets, mutateBroker, type BrokerKind } from "./brokerAccounts";
import { rateLimit } from "./rateLimit";

async function imageUpload(request:Request) {
  if(!request.headers.get('content-type')?.startsWith('multipart/form-data;'))throw new RecordsError('需要图片表单');
  let f:FormData;
  try{f=await readFormBody(request,2097152+16384);}catch(e){if(e instanceof RequestBodyTooLargeError)throw e;throw new RecordsError('图标表单无效');}
  if([...f.keys()].some(k=>!['requestId','revision','file'].includes(k))||['requestId','revision','file'].some(k=>f.getAll(k).length!==1))throw new RecordsError('表单字段无效');
  const file=f.get('file'),revision=f.get('revision');
  if(!file||typeof file==='string'||typeof revision!=='string'||!/^(0|[1-9]\d*)$/.test(revision))throw new RecordsError('图标或版本无效');
  if(file.size>2097152)throw new RequestBodyTooLargeError();
  if(!file.size||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new RecordsError('图片类型无效');
  const bytes=Buffer.from(await file.arrayBuffer());
  const magic=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'webp':null;
  if(!magic||file.type!==`image/${magic}`)throw new RecordsError('图片内容无效');
  try {
    const img=sharp(bytes,{animated:true,limitInputPixels:16777216,failOn:'warning'}),meta=await img.metadata();
    if(meta.format!==magic||!meta.width||!meta.height||meta.width>4096||meta.height>4096||meta.width*meta.height>16777216||(meta.pages??1)!==1)throw new Error('invalid image');
    if(magic==='png'&&bytes.includes(Buffer.from('acTL')))throw new Error('animation');
    const icon=await img.rotate().resize(512,512,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
    return {body:{requestId:f.get('requestId'),revision:Number(revision)},icon};
  }catch{throw new RecordsError('图片无法安全解码');}
}
export async function brokerAccountsResponse(request:Request,action:'list'|'account'|'presets'|'operation'|'icon'|'bindings'|'unbindings',version:1|2,params?:Promise<{accountId?:string;requestId?:string}>) {
  try {
    const auth=brokerRequestAuth(request),initial={user_id:auth.userId},authorize=auth.authorize;
    const p=params?await params:{};authorize();
    if(new URL(request.url).searchParams.size)throw new RecordsError('不支持查询参数');
    if(p.accountId&&!/^ba-[a-f0-9]{24}$/.test(p.accountId))throw new RecordsError('账户不存在',404);
    if(request.method==='GET')return getDb().transaction(()=>{
      authorize();
      if(action==='presets')return ok({items:brokerPresets()});
      if(action==='operation')return ok(brokerOperation(initial.user_id,p.requestId??''));
      if(action==='list')return ok(brokerAccountList(initial.user_id,version));
      if(action==='account')return ok(brokerAccount(initial.user_id,p.accountId??'',version));
      const bytes=brokerIcon(initial.user_id,p.accountId??'');
      return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'image/png','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
    })();
    if(!rateLimit(`broker-write:${initial.user_id}`,60,60000))throw new RecordsError('提交过于频繁',429);
    let kind:BrokerKind,body:unknown,icon:Buffer|undefined;
    if(action==='icon'&&request.method==='POST'){kind='upload_icon';const upload=await imageUpload(request);body=upload.body;icon=upload.icon;}
    else {
      if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new RecordsError('需要JSON请求');
      body=await readJsonBody(request,8192);
      kind=action==='unbindings'&&request.method==='POST'?'unbind_records':action==='bindings'&&request.method==='POST'?'bind_records':action==='list'&&request.method==='POST'?'create':action==='account'&&request.method==='PUT'?'update':action==='account'&&request.method==='DELETE'?'delete':action==='icon'&&request.method==='DELETE'?'reset_icon':(()=>{throw new RecordsError('不支持此方法',405);})();
    }
    const {result,error}=mutateBroker(initial.user_id,kind,p.accountId??'',body,version,authorize,icon);
    if(error)return fail(error.code,error.message,error.status);
    const response=ok(result);return kind==='create'?new Response(response.body,{status:201,headers:response.headers}):response;
  }catch(e){if(e instanceof RequestBodyTooLargeError)return fail(41301,'文件或请求过大',413);if(e instanceof RecordsError)return fail(e.code,e.message,e.status);return fail(50001,'账户暂时无法保存或读取',500);}
}
