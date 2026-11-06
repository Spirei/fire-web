import {platformJson,platformRequest} from './platformTransport';
export async function logSecurityEvent(request:Request,_userId:string,event:string,detail=''){
 const cookie=request.headers.get('cookie')||'';
 const {csrf}=await platformJson<{csrf:string}>('/api/fire/session',{cookie});
 const response=await platformRequest('/api/fire/showcase/audit',{method:'POST',internal:true,headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:new Response(JSON.stringify({event,detail})).body});
 if(!response.ok)throw new Error('上传审计未完成');
}
