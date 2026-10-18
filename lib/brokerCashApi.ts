import { getDb } from './db';
import { brokerRequestAuth } from './brokerRequestAuth';
import { ok, fail } from './api';
import { RecordsError } from './recordsContract';
import { readJsonBody, RequestBodyTooLargeError } from './requestBody';
import { rateLimit } from './rateLimit';
import { brokerCashSummary,brokerCashSnapshot,brokerCashEntries,previewBrokerCash,submitBrokerCash } from './brokerCash';
export async function brokerCashResponse(request:Request,action:'summary'|'account'|'entries'|'preview'|'submit',params?:Promise<{accountId:string}>){
  try{
    const auth=brokerRequestAuth(request),p=params?await params:undefined;auth.authorize();const query=new URL(request.url).searchParams;
    if(action!=='entries'&&query.size)throw new RecordsError('不支持查询参数');
    if(action==='summary'||action==='account'||action==='entries')return getDb().transaction(()=>{
      auth.authorize();if(action==='summary')return ok(brokerCashSummary(auth.userId));if(action==='account')return ok(brokerCashSnapshot(auth.userId,p!.accountId));
      if([...query.keys()].some(k=>!['currency','limit','offset','snapshotRevision'].includes(k)||query.getAll(k).length!==1))throw new RecordsError('流水参数无效');
      const limit=query.get('limit')??'50',offset=query.get('offset')??'0',revision=query.get('snapshotRevision')??undefined;
      if(!/^[1-9]\d*$/.test(limit)||Number(limit)>200||!/^\d+$/.test(offset)||!Number.isSafeInteger(Number(offset))||revision!==undefined&&!/^[a-f0-9]{64}$/.test(revision))throw new RecordsError('流水分页无效');
      return ok(brokerCashEntries(auth.userId,p!.accountId,query.get('currency')??'',Number(limit),Number(offset),revision));
    })();
    if(!rateLimit('broker-cash:'+auth.userId,60,60000))throw new RecordsError('请求过于频繁',429);
    const body=await readJsonBody(request,8192);auth.authorize();
    if(action==='preview')return ok(getDb().transaction(()=>{auth.authorize();return previewBrokerCash(auth.userId,body);})());
    const out=submitBrokerCash(auth.userId,body,auth.authorize);return out.error?fail(out.error.code,out.error.message,out.error.status):ok(out.result);
  }catch(e){const error=e instanceof RecordsError?e:e instanceof RequestBodyTooLargeError?new RecordsError('请求内容超过上限',413):new RecordsError('资金未确认，请查询原UUID回执',500);return fail(error.code,error.message,error.status);}
}
