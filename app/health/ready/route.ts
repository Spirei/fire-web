import {platformRequest} from '@/lib/platformTransport';
export const dynamic='force-dynamic';
export async function GET(){try{return await platformRequest('/health/ready',{internal:true});}catch{return Response.json({ready:false},{status:503,headers:{'cache-control':'no-store'}});}}
