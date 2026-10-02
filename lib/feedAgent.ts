import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { feedTables, feedGroup, getFeedJob, FeedError } from "./feedStore";
import { removeFileIfUnused } from "./fileCleanup";
import { validateImageContent } from "./imageSecurity";
import type { FeedAgentProfile, FeedJob, FeedJobPage } from "./feedTypes";

export function feedAgentProfile(userId:string):FeedAgentProfile {
  const r=feedTables().prepare("SELECT name,image,revision,updated_at FROM feed_agent_profiles WHERE user_id=?").get(userId) as {name:string;image:string|null;revision:number;updated_at:string|null}|undefined;
  return r?{name:r.name,image:r.image,revision:r.revision,updatedAt:r.updated_at}:{name:"Alcor",image:null,revision:0,updatedAt:null};
}
function revision(value:unknown):number {
  if(!Number.isSafeInteger(value)||Number(value)<0)throw new FeedError("请重新读取形象后编辑");
  return Number(value);
}
function writeProfile(userId:string,expected:number,patch:Partial<Pick<FeedAgentProfile,"name"|"image">>) {
  const db=feedTables();
  const result=db.transaction(()=>{
    const current=feedAgentProfile(userId);
    if(current.revision!==expected)throw new FeedError("名称或形象已在另一端修改，请重新读取后编辑",409);
    const next={...current,...patch,revision:current.revision+1,updatedAt:new Date().toISOString()};
    db.prepare("INSERT INTO feed_agent_profiles(user_id,name,image,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,image=excluded.image,revision=excluded.revision,updated_at=excluded.updated_at").run(userId,next.name,next.image,next.revision,next.updatedAt);
    return {profile:next,oldImage:current.image};
  }).immediate();
  if(result.oldImage!==result.profile.image){try{removeFileIfUnused(result.oldImage);}catch{/* A committed replacement must survive a cleanup failure. */}}
  return result.profile;
}
export function saveFeedAgentProfile(userId:string,body:unknown) {
  if(!body||typeof body!=="object"||Array.isArray(body))throw new FeedError("名称或形象格式无效");
  const b=body as Record<string,unknown>;
  if(Object.keys(b).some(k=>!["name","resetAvatar","revision"].includes(k))||((b.name===undefined)===(b.resetAvatar===undefined)))throw new FeedError("请选择编辑名称或恢复默认形象");
  const expected=revision(b.revision);
  if(b.resetAvatar!==undefined) {
    if(b.resetAvatar!==true)throw new FeedError("形象选项无效");
    return writeProfile(userId,expected,{image:null});
  }
  if(typeof b.name!=="string"||!b.name.trim()||b.name.trim().length>40||/[\u0000-\u001f\u007f]/.test(b.name))throw new FeedError("名称为1–40字");
  return writeProfile(userId,expected,{name:b.name.trim()});
}
export function saveFeedAgentImage(userId:string,buffer:Buffer,filename:string,expected:unknown) {
  if(!/^[a-zA-Z0-9_-]+$/.test(userId))throw new FeedError("账号标识无效");
  const rev=revision(expected),ext=path.extname(filename).slice(1).toLowerCase();
  if(!buffer.length||buffer.length>2*1024*1024)throw new FeedError("图片最大 2 MB",413);
  if(!["png","jpg","jpeg","webp","gif"].includes(ext))throw new FeedError("请选择 PNG、JPG、WebP 或 GIF 图片");
  const actual=validateImageContent(buffer,ext);if(!actual)throw new FeedError("图片内容与格式不符");
  const url=`/uploads/avatar/${userId}/agent-${randomBytes(12).toString("hex")}.${actual}`;
  const file=path.join(process.cwd(),"public",url);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,buffer,{flag:"wx"});
  try{return writeProfile(userId,rev,{image:url});}
  catch(error){fs.unlinkSync(file);throw error;}
}
export function feedAgentJobs(userId:string,groupId="default",cursor:string|null=null):FeedJobPage {
  feedGroup(userId,groupId);getFeedJob(userId,undefined,groupId);
  let time="",id="";
  if(cursor) {
    try {
      if(cursor.length>256)throw new Error();
      const value=JSON.parse(Buffer.from(cursor,"base64url").toString());
      if(!Array.isArray(value)||value.length!==2||typeof value[0]!=="string"||!Number.isFinite(Date.parse(value[0]))||typeof value[1]!=="string"||!/^fj-[a-f0-9]{24}$/.test(value[1]))throw new Error();
      [time,id]=value;
    }catch{throw new FeedError("记录分页无效");}
  }
  const rows=feedTables().prepare(`SELECT id,status,created_at,updated_at,added,error,revision,group_id FROM feed_jobs WHERE user_id=? AND group_id=? ${cursor?"AND (created_at<? OR (created_at=? AND id<?))":""} ORDER BY created_at DESC,id DESC LIMIT 31`).all(userId,groupId,...(cursor?[time,time,id]:[])) as {id:string;status:FeedJob["status"];created_at:string;updated_at:string;added:number;error:string|null;revision:number;group_id:string}[];
  const jobs=rows.slice(0,30).map(r=>({id:r.id,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,added:r.added,error:r.error,revision:r.revision,groupId:r.group_id}));
  const last=jobs.at(-1);
  return {jobs,nextCursor:rows.length>30&&last?Buffer.from(JSON.stringify([last.createdAt,last.id])).toString("base64url"):null};
}
