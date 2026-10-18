import sharp from 'sharp';
import { assetGrant } from './appAssetsApi';
import { personalProfile,personalBackground,personalOperation,mutatePersonalProfile } from './personalProfile';
import { ok,fail } from './api';
import { RecordsError } from './recordsContract';
import { readFormBody,readJsonBody,RequestBodyTooLargeError } from './requestBody';
import { rateLimit } from './rateLimit';
export async function personalProfileResponse(request:Request,action:'profile'|'background'|'operation',version:1|2,params?:Promise<{requestId:string}>){try{
 const scope=request.method==='GET'?'portfolio.read':'profile.write',initial=assetGrant(request,scope),authorize=()=>{const g=assetGrant(request,scope);if(g.id!==initial.id||g.user_id!==initial.user_id||g.security_stamp!==initial.security_stamp)throw new RecordsError('连接已变化',401);return g.user_id;};
 const p=params?await params:null;authorize();if(new URL(request.url).searchParams.size)throw new RecordsError('不支持查询参数');
 if(request.method==='GET'){if(action==='operation')return ok(personalOperation(initial.user_id,p!.requestId));if(action==='profile')return ok(personalProfile(initial.user_id,version));return new Response(new Uint8Array(personalBackground(initial.user_id)),{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});}
 if(!rateLimit(`personal-profile:${initial.user_id}`,30,60000))throw new RecordsError('保存过于频繁',429);
 let body:unknown,bytes:Buffer|undefined;
 if(action==='background'){
  if(!request.headers.get('content-type')?.startsWith('multipart/form-data;'))throw new RecordsError('需要图片表单');
  const f=await readFormBody(request,8388608+16384);if([...f.keys()].some(k=>!['file','requestId','revision','migration'].includes(k))||['file','requestId','revision'].some(k=>f.getAll(k).length!==1)||f.getAll('migration').length>1)throw new RecordsError('表单无效');
  const file=f.get('file'),revision=f.get('revision'),migration=f.get('migration');if(!file||typeof file==='string'||file.type!=='image/jpeg'||file.size<3||file.size>8388608||typeof revision!=='string'||!/^(0|[1-9]\d*)$/.test(revision)||migration!==null&&migration!=='true'&&migration!=='false')throw new RecordsError('图片或版本无效');
  const raw=Buffer.from(await file.arrayBuffer());if(raw[0]!==255||raw[1]!==216||raw[2]!==255)throw new RecordsError('需要真实JPEG图片');
  try{const image=sharp(raw,{limitInputPixels:4194304,failOn:'warning'}),meta=await image.metadata();if(meta.format!=='jpeg'||!meta.width||!meta.height||meta.width>2048||meta.height>2048||(meta.pages??1)!==1)throw Error();bytes=await image.rotate().jpeg({quality:90}).toBuffer();if(bytes.length>8388608)throw Error();}catch{throw new RecordsError('图片无法安全解码或尺寸超过2048像素');}
  body={requestId:f.get('requestId'),revision:Number(revision),...(migration===null?{}:{migration:migration==='true'})};
 }else{if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw new RecordsError('需要JSON请求');body=await readJsonBody(request,16384);}
 const {result,error}=mutatePersonalProfile(initial.user_id,body,version,authorize,bytes);return error?fail(error.code,error.message,error.status):ok(result);
}catch(e){if(e instanceof RecordsError)return fail(e.code,e.message,e.status);if(e instanceof RequestBodyTooLargeError)return fail(41301,'图片或请求过大',413);return fail(50001,'资料暂时无法保存或读取',500);}}
