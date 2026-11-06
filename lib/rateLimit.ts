import {platformJson,platformRequest} from './platformTransport';
/** Presentation uploads share PG-backed native admission. Service failure rejects the operation. */
export async function showcaseBudget(request:Request,category:string):Promise<boolean>{
 try{
  const cookie=request.headers.get('cookie')||'';
  const {csrf}=await platformJson<{csrf:string}>('/api/fire/session',{cookie});
  const response=await platformRequest('/api/fire/showcase/budget/'+category,{method:'POST',headers:{cookie,'x-csrf-token':csrf},internal:true});
  return response.ok&&(await response.json()).allowed===true;
 }catch{return false;}
}
