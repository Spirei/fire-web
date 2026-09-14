import { getAuthUser } from "@/lib/auth";
import { assistantUsage } from "@/lib/assistantWorkspace";
export const dynamic="force-dynamic";
export async function GET(request:Request){const user=getAuthUser(request);return user?Response.json(assistantUsage(user.id),{headers:{"Cache-Control":"no-store"}}):Response.json({error:"未登录"},{status:401});}
