import { assetGrant } from './appAssetsApi';
import { RecordsError } from './recordsContract';
/** App-only identity and scopes; recheck after every asynchronous input/provider wait. */
export function brokerRequestAuth(request:Request) {
  const initial=assetGrant(request);
  return {userId:initial.user_id,authorize:()=>{
    const g=assetGrant(request);
    if(g.id!==initial.id||g.user_id!==initial.user_id||g.security_stamp!==initial.security_stamp)throw new RecordsError('连接已变化',401);
    return g.user_id;
  }};
}
