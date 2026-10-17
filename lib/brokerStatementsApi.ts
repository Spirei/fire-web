import { brokerRequestAuth } from './brokerRequestAuth';
import { RecordsError } from './recordsContract';
import { ok,fail } from './api';
import { readJsonBody,readFormBody,RequestBodyTooLargeError } from './requestBody';
import { statementConnector } from './brokerConnectors';
import { FLEX_MAX_BYTES } from './ibkrFlex';
import { statementStatus,saveFlexConnection,deleteFlexConnection,prepareFlexPreview,fetchFlexPreview,applyFlexPreview } from './brokerStatements';
import { rateLimit } from './rateLimit';
export async function brokerStatementsResponse(request:Request,action:'connection'|'preview'|'fetch'|'apply',params:Promise<{accountId:string}>){
  try {
    const auth=brokerRequestAuth(request),{accountId}=await params;auth.authorize();
    if(!/^ba-[a-f0-9]{24}$/.test(accountId))throw new RecordsError('账户不存在',404);
    if(new URL(request.url).searchParams.size)throw new RecordsError('不支持查询参数');
    if(request.method==='GET')return ok(statementStatus(auth.userId,accountId));
    if(!rateLimit(`broker-statement:${auth.userId}`,30,60000))throw new RecordsError('操作过于频繁',429);
    if(action==='preview'){
      if(!request.headers.get('content-type')?.startsWith('multipart/form-data;'))throw new RecordsError('需要XML文件表单');
      const f=await readFormBody(request,FLEX_MAX_BYTES+16384);if([...f.keys()].some(k=>!['file','externalAccount','connectorId'].includes(k))||f.getAll('connectorId').length>1||f.getAll('file').length!==1||f.getAll('externalAccount').length!==1)throw new RecordsError('表单字段无效');
      const file=f.get('file'),external=f.get('externalAccount');if(!file||typeof file==='string'||!file.size||file.size>FLEX_MAX_BYTES||typeof external!=='string'||! /^[A-Za-z0-9-]{2,40}$/.test(external))throw new RecordsError('请选择有效XML账单及账户编号');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());auth.authorize();return ok(prepareFlexPreview(auth.userId,accountId,text,external,auth.authorize,typeof f.get('connectorId')==='string'?String(f.get('connectorId')):'ibkr-flex'));
    }
    if(action==='fetch'){const result=await fetchFlexPreview(auth.userId,accountId,auth.authorize);const response=ok(result);return result.pending?new Response(response.body,{status:202,headers:response.headers}):response;}
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json')throw new RecordsError('需要JSON请求');
    const b=await readJsonBody(request,4096);auth.authorize();if(!b||typeof b!=='object'||Array.isArray(b))throw new RecordsError('请求无效');
    if(b.connectorId!==undefined&&typeof b.connectorId!=='string')throw new RecordsError('渠道ID无效');
    const allowed=action==='apply'?['requestId','revision','previewId','acknowledgeUnassigned']:request.method==='DELETE'?['requestId','revision']:['requestId','revision','connectorId',...(statementConnector(b.connectorId??'ibkr-flex')?.fields.map(f=>f.key)??[])];
    if(Object.keys(b).some(k=>!allowed.includes(k)))throw new RecordsError('含未知字段');
    if(action==='apply')return ok(applyFlexPreview(auth.userId,accountId,b,auth.authorize));
    return ok(request.method==='DELETE'?deleteFlexConnection(auth.userId,accountId,b,auth.authorize):saveFlexConnection(auth.userId,accountId,b,auth.authorize));
  }catch(e){if(e instanceof RequestBodyTooLargeError)return fail(41301,'文件或请求过大',413);if(e instanceof RecordsError)return fail(e.code,e.message,e.status);return fail(50001,'账单暂时无法读取或保存',500);}
}
