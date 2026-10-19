import { assetGrant } from './appAssetsApi';
import { getDb } from './db';
import { fail, ok } from './api';
import { RecordsError } from './recordsContract';
import { rateLimit } from './rateLimit';
import { readJsonBody, RequestBodyTooLargeError } from './requestBody';
import { historicalFeeSnapshot, previewHistoricalFees, submitHistoricalFees } from './historicalFees';

export async function historicalFeeResponse(request:Request,action:'snapshot'|'preview'|'submit'){
  try{
    const scope=action==='snapshot'?'orders.read':'orders.write',first=assetGrant(request,scope),authorize=()=>{
      const current=assetGrant(request,scope);
      if(current.id!==first.id||current.user_id!==first.user_id||current.security_stamp!==first.security_stamp)throw new RecordsError('连接已变化',401);
      return current.user_id;
    };
    const query=new URL(request.url).searchParams;authorize();
    if(action==='snapshot'){
      if(query.size!==1||query.getAll('brokerAccountId').length!==1||!/^ba-[a-f0-9]{24}$/.test(query.get('brokerAccountId')??''))throw new RecordsError('须指定本人券商账户');
      return ok(getDb().transaction(()=>{authorize();return historicalFeeSnapshot(first.user_id,query.get('brokerAccountId')!);})());
    }
    if(query.size)throw new RecordsError('不支持查询参数');
    if(!rateLimit('historical-fees:'+first.user_id,30,60_000))throw new RecordsError('核对过于频繁',429);
    const body=await readJsonBody(request,131_072);authorize();
    if(action==='preview')return ok(getDb().transaction(()=>{authorize();return previewHistoricalFees(first.user_id,body);})());
    const out=submitHistoricalFees(first.user_id,body,authorize);return out.error?fail(out.error.code,out.error.message,out.error.status):ok(out.result);
  }catch(e){const status=e instanceof RecordsError?e.status:e instanceof RequestBodyTooLargeError?413:500;return fail(e instanceof RecordsError?e.code:status*100+1,e instanceof RecordsError?e.message:status===413?'请求内容超过上限':'费用更正未确认，请查询原UUID回执',status);}
}
