import {tradeFeeOk,validateFeeTransportInput} from "./tradeFeeTransport";
import {assetGrant} from './appAssetsApi';
import {RecordsError} from './recordsContract';
import {ok,fail} from './api';
import {readJsonBody,RequestBodyTooLargeError} from './requestBody';
import {rateLimit} from './rateLimit';
import {previewTradeCorrection,submitTradeCorrection} from './tradeCorrections';
import {getDb} from './db';
export async function tradeCorrectionResponse(request:Request,preview:boolean){try{
  const first=assetGrant(request,'orders.write'),authorize=()=>{const now=assetGrant(request,'orders.write');if(now.id!==first.id||now.user_id!==first.user_id||now.security_stamp!==first.security_stamp)throw new RecordsError('连接已变化',401);return now.user_id;};
  if(new URL(request.url).searchParams.size)throw new RecordsError('不接受查询参数');authorize();
  if(!rateLimit('trade-corrections:'+first.user_id,30,60_000))throw new RecordsError('请求过于频繁',429);
  const body=await readJsonBody(request,131072);authorize();validateFeeTransportInput(request,body);
  if(preview)return tradeFeeOk(request,getDb().transaction(()=>{authorize();return previewTradeCorrection(first.user_id,body);})());
  const out=submitTradeCorrection(first.user_id,body,authorize);return out.error?fail(out.error.code,out.error.message,out.error.status):tradeFeeOk(request,out.result);
}catch(e){const status=e instanceof RecordsError?e.status:e instanceof RequestBodyTooLargeError?413:500;return fail(e instanceof RecordsError?e.code:status*100+1,e instanceof RecordsError?e.message:status===413?'请求内容超出上限':'更正结果未确认，请查询原UUID回执',status);}}
