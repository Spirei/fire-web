import { feedNotificationsResponse } from "@/lib/feedNotificationsApi";
export const dynamic="force-dynamic";
type Context={params:Promise<{action?:string[]}>};
async function handle(request:Request,context:Context){return feedNotificationsResponse(request,context.params);}
export const GET=handle;export const PUT=handle;export const POST=handle;export const DELETE=handle;
