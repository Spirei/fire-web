import { getAuthUser } from "@/lib/auth";
import { assistantUsage } from "@/lib/assistantWorkspace";
export const dynamic="force-dynamic";
export async function GET(request:Request){const user=getAuthUser(request);if(!user)return Response.json({error:"未登录"},{status:401});const conversationId=new URL(request.url).searchParams.get("conversationId")?.slice(0,40)||"";return Response.json(assistantUsage(user.id,conversationId),{headers:{"Cache-Control":"no-store"}});}
