import { feedNotificationsResponse } from "@/lib/feedNotificationsApi";
import { appV2Response } from "@/lib/appApiV2";
export const dynamic="force-dynamic";
type Context={params:Promise<{action?:string[]}>};
async function handle(request:Request,context:Context){return appV2Response(request,()=>feedNotificationsResponse(request,context.params));}
export const GET=handle;export const PUT=handle;export const POST=handle;export const DELETE=handle;
