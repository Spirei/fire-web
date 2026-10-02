import { feedAgentProfile,saveFeedAgentProfile,saveFeedAgentImage,feedAgentJobs } from "@/lib/feedAgent";
import { FEED_PAGE_SIZE } from "@/lib/feedTypes";
import { after } from "next/server";
import { ok,fail } from "@/lib/api";
import { getAuthUser,isTrustedMutationRequest,isAdmin } from "@/lib/auth";
import { readJsonBody,readFormBody,RequestBodyTooLargeError } from "@/lib/requestBody";
import { clientIp,rateLimit } from "@/lib/rateLimit";
import { FeedError,feedMessages,getFeedJob,getFeedPost,saveFeedPreferences,updateFeedPost,createFeedGroup,listFeedGroups,feedGroup } from "@/lib/feedStore";
import { discussFeed,feedSnapshot,requestFeedGeneration,runFeedJob } from "@/lib/feedGeneration";
import { normalizeFeedSubscriptions,readFeedSubscription } from "@/lib/feedSubscriptions";

export const dynamic="force-dynamic";
type Context={params:Promise<{action?:string[]}>};
async function handle(request:Request,context:Context) {
  try {
    const user=getAuthUser(request);
    if(!user)throw new FeedError("请先登录或重新连接",401);
    if(!isTrustedMutationRequest(request))throw new FeedError("不允许跨站操作",403);
    if(!rateLimit(`feed-api:${user.id}:${clientIp(request)}`,180,60_000))throw new FeedError("请求过于频繁",429);
    const action=(await context.params).action||[],key=action.join("/"),method=request.method;
    const groupId=new URL(request.url).searchParams.get("group")||"default";
    if(method==="GET") {
      if(!key) {
        const q=new URL(request.url).searchParams,raw=q.get("limit"),limit=raw===null?FEED_PAGE_SIZE:Number(raw);
        if(!Number.isInteger(limit)||limit<1||limit>50)throw new FeedError("每页条数为1–50");
        const snapshot=feedSnapshot(user.id,q.get("cursor"),limit,groupId,q.get("author"));
        snapshot.capabilities.editPeopleAvatars=isAdmin(user);return ok(snapshot);
      }
      if(key==="profile")return ok(feedAgentProfile(user.id));
      if(key==="jobs")return ok(feedAgentJobs(user.id,groupId,new URL(request.url).searchParams.get("cursor")));
      if(key==="groups")return ok({groups:listFeedGroups(user.id)});
      if(action.length===2&&action[0]==="jobs") {
        const job=getFeedJob(user.id,action[1]);if(!job)throw new FeedError("任务不存在",404);return ok(job);
      }
      if(action.length===2&&action[0]==="posts")return ok(getFeedPost(user.id,action[1]));
      if(action.length===3&&action[0]==="posts"&&action[2]==="discussion")return ok({messages:feedMessages(user.id,action[1])});
      throw new FeedError("接口不存在",404);
    }
    if(method==="POST"&&key==="profile/avatar") {
      if(!rateLimit(`feed-agent-upload:${user.id}`,30,60*60_000))throw new FeedError("上传较频繁，请稍后再试",429);
      let form:FormData;
      try{form=await readFormBody(request,2*1024*1024+65536);}catch(error){if(error instanceof RequestBodyTooLargeError)throw error;throw new FeedError("图片上传格式无效");}
      const file=form.get("file"),rawRevision=form.get("revision");
      if(!(file instanceof File)||typeof rawRevision!=="string"||!/^\d+$/.test(rawRevision)||[...form.keys()].some(k=>!["file","revision"].includes(k))||form.getAll("file").length!==1||form.getAll("revision").length!==1)throw new FeedError("请选择图片后上传");
      const buffer=Buffer.from(await file.arrayBuffer());
      if(getAuthUser(request)?.id!==user.id)throw new FeedError("连接已失效",401);
      return ok(saveFeedAgentImage(user.id,buffer,file.name,Number(rawRevision)));
    }
    const body=await readJsonBody(request,20_000);
    // Revalidate after asynchronous input: revoked tokens cannot finish a queued mutation.
    if(getAuthUser(request)?.id!==user.id)throw new FeedError("连接已失效",401);
    if(method==="PUT"&&key==="profile")return ok(saveFeedAgentProfile(user.id,body));
    if(method==="POST"&&key==="groups") {
      const group=createFeedGroup(user.id,body);
      if(group.mode==="people") {
        try{const result=requestFeedGeneration(user.id,group.id);if(result.created)after(()=>runFeedJob(user.id,result.job.id));}catch{/* Group is saved; scheduler/manual retry can read its originals later. */}
      }
      return ok(group);
    }
    if(method==="POST"&&key==="subscriptions/test") {
      if(!rateLimit(`feed-source-test:${user.id}`,6,60_000))throw new FeedError("测试较频繁，请稍后再试",429);
      const source=normalizeFeedSubscriptions([body])[0];
      try{const result=await readFeedSubscription(source);return ok({title:result.title,count:result.sources.length,url:source.url});}catch{throw new FeedError("未读到有效订阅，请检查公开RSS/Atom地址及服务器网络；不会保存无效数据",502);}
    }
    if(method==="PUT"&&action.length===2&&action[0]==="groups") {
      if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["name","revision"].includes(k))||typeof body.name!=="string")throw new FeedError("请填写名称及版本");
      const current=feedSnapshot(user.id,null,1,action[1]);saveFeedPreferences(user.id,{instructions:current.preferences.instructions,name:body.name,revision:body.revision},action[1]);return ok(feedGroup(user.id,action[1]));
    }
    if(method==="PUT"&&key==="preferences")return ok(saveFeedPreferences(user.id,body,groupId));
    if(method==="POST"&&key==="refresh") {
      if(body && (typeof body!=="object"||Array.isArray(body)||Object.keys(body).length))throw new FeedError("刷新不接受额外字段");
      const result=requestFeedGeneration(user.id,groupId);
      if(result.created)after(()=>runFeedJob(user.id,result.job.id));
      return ok(result.job);
    }
    if(method==="PUT"&&action.length===2&&action[0]==="posts")return ok(updateFeedPost(user.id,action[1],body));
    if(method==="POST"&&action.length===3&&action[0]==="posts"&&action[2]==="discussion") {
      if(!body||Array.isArray(body)||typeof body.text!=="string"||!body.text.trim()||body.text.length>2000||Object.keys(body).some(k=>k!=="text"))throw new FeedError("讨论内容为1–2000字");
      if(!rateLimit(`feed-discuss:${user.id}`,20,60*60_000))throw new FeedError("讨论较频繁，请稍后再试",429);
      const messages=await discussFeed(user.id,action[1],body.text.trim(),request.signal,()=>getAuthUser(request)?.id===user.id);
      return ok({messages});
    }
    throw new FeedError("接口不存在",404);
  }catch(e){const status=e instanceof FeedError?e.status:e instanceof RequestBodyTooLargeError?413:500;return fail(status*100+1,e instanceof FeedError?e.message:status===413?"内容过长":"动态服务暂不可用",status);}
}
export const GET=handle;
export const PUT=handle;
export const POST=handle;
