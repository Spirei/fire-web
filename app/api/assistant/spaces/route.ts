import { getAuthUser } from "@/lib/auth";
import { createAssistantSpace, deleteAssistantSpace, listAssistantSpaces, listConversationSpaces, setConversationSpace } from "@/lib/assistantWorkspace";
import { readLimitedJson } from "@/lib/requestBody";

export async function GET(request:Request){const user=getAuthUser(request);return user?Response.json({spaces:listAssistantSpaces(user.id),assignments:listConversationSpaces(user.id)}):Response.json({error:"未登录"},{status:401});}
export async function POST(request:Request){const user=getAuthUser(request);if(!user)return Response.json({error:"未登录"},{status:401});try{const body=await readLimitedJson<Record<string,unknown>>(request,4096);return Response.json({space:createAssistantSpace(user.id,body?.name)});}catch(error){return Response.json({error:error instanceof Error?error.message:"创建失败"},{status:400});}}
export async function PUT(request:Request){const user=getAuthUser(request);if(!user)return Response.json({error:"未登录"},{status:401});try{const body=await readLimitedJson<Record<string,unknown>>(request,4096);setConversationSpace(user.id,String(body?.conversationId||""),String(body?.spaceId||""));return Response.json({ok:true});}catch(error){return Response.json({error:error instanceof Error?error.message:"保存失败"},{status:400});}}
export async function DELETE(request:Request){const user=getAuthUser(request);if(!user)return Response.json({error:"未登录"},{status:401});deleteAssistantSpace(user.id,new URL(request.url).searchParams.get("id")||"");return Response.json({ok:true});}
