import { assetGrant } from './appAssetsApi';
import { alertSnapshot,alertOperation,mutateAlert,beginTelegram } from './priceAlerts';
import { fail,ok } from './api';
import { readJsonBody,RequestBodyTooLargeError } from './requestBody';
import { RecordsError } from './recordsContract';
import { rateLimit } from './rateLimit';
export async function priceAlertsResponse(request:Request,action:'snapshot'|'operation'|'telegram',requestId='') {
  try {
    if(new URL(request.url).search)throw new RecordsError('不支持查询参数');
    const write=request.method!=='GET',scope=write?'portfolio.write':'portfolio.read',initial=assetGrant(request,scope);
    const authorize=()=>{const current=assetGrant(request,scope);if(current.id!==initial.id||current.user_id!==initial.user_id||current.security_stamp!==initial.security_stamp)throw new RecordsError('账户连接已变化',401);};
    if(!rateLimit(`price-alerts:${write?'write':'read'}:${initial.user_id}`,write?60:180,60000))throw new RecordsError('请求过于频繁',429);
    const negotiated=request.headers.get('X-Alcor-Price-Alerts');
    const visible=negotiated==='messengers-v1'?['app','email','telegram','wechat','feishu','discord','qq']:negotiated==='wechat-v1'?['app','email','telegram','wechat']:['app','email','telegram'];
    const snapshot=(value:ReturnType<typeof alertSnapshot>)=>({...value,channels:value.channels.filter(channel=>visible.includes(channel.channel))});
    const receipt=(value:ReturnType<typeof alertOperation>)=>({...value,snapshot:snapshot(value.snapshot)});
    if(action==='snapshot')return ok(snapshot(alertSnapshot(initial.user_id)));
    if(action==='operation'&&!write)return ok(receipt(alertOperation(initial.user_id,requestId)));
    const body=await readJsonBody(request,16384);authorize();
    if(action==='telegram'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new RecordsError('绑定请求无效');
      if(!rateLimit(`price-alert-telegram:${initial.user_id}`,5,60000))throw new RecordsError('绑定过于频繁',429);
      return ok(beginTelegram(initial.user_id));
    }
    const requestedAction=body&&typeof body==='object'&&'action' in body?String(body.action):'';
    const requested=body&&typeof body==='object'&&'channel' in body?String(body.channel):'';
    const messenger=/^(feishu|discord|qq)_(start|confirm|disconnect)$/.test(requestedAction)||['feishu','discord','qq'].includes(requested);
    const wechat=requestedAction.startsWith('wechat_')||requested==='wechat';
    if(messenger&&negotiated!=='messengers-v1')throw new RecordsError('客户端不支持此绑定操作');
    if(wechat&&negotiated!=='wechat-v1'&&negotiated!=='messengers-v1')throw new RecordsError('客户端不支持此绑定操作');
    return ok(receipt(mutateAlert(initial,requestId,body,authorize)));
  } catch(error) {
    const status=error instanceof RecordsError?error.status:error instanceof RequestBodyTooLargeError?413:500;
    return fail(status*100+1,error instanceof RecordsError?error.message:status===413?'请求内容过大':'股价提醒操作未确认，请查询原回执',status);
  }
}
