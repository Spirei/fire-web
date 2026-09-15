import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import { validateImageContent } from "./imageSecurity";

const MIME_EXT:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};
export function saveAssistantAttachments(userId:string,conversationId:string,items:Array<{name:string;dataUrl:string}>){
  if(!/^ac-[a-f0-9]{24}$/.test(conversationId)) throw new Error("会话标识无效");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId) || !Array.isArray(items) || items.length > 8) throw new Error("附件数量或用户标识无效");
  let total=0;
  const parsed=items.map(item=>{const match=item.dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);if(!match)throw new Error("图片数据无效");const data=Buffer.from(match[2],"base64");if(data.length>8*1024*1024 || !MIME_EXT[match[1].toLowerCase()] || !validateImageContent(data,MIME_EXT[match[1].toLowerCase()]))throw new Error("仅支持有效的 PNG、JPEG、GIF、WebP 图片，每张最多 8MB");total+=data.length;return {name:String(item.name||"图片").slice(0,120),mime:match[1].toLowerCase(),data};});
  if(total>20*1024*1024)throw new Error("图片总大小不能超过 20MB");
  const usage=getDb().prepare("SELECT COALESCE(SUM(size),0) AS size, COUNT(*) AS count FROM assistant_attachments WHERE user_id=?").get(userId) as {size:number;count:number};
  if(usage.size+total>200*1024*1024 || usage.count+items.length>1000)throw new Error("附件空间已满，请删除旧会话后重试");
  const root=path.join(process.cwd(),"data","assistant-attachments",userId,conversationId);fs.mkdirSync(root,{recursive:true});
  return getDb().transaction(()=>parsed.map(item=>{const id=`ai-${randomBytes(12).toString("hex")}`;const ext=MIME_EXT[item.mime];const data=item.data;const file=`${id}.${ext}`;fs.writeFileSync(path.join(root,file),data,{mode:0o600});const url=`/api/assistant/attachments?id=${id}`;getDb().prepare("INSERT INTO assistant_attachments(id,user_id,conversation_id,name,url,size,created_at) VALUES(?,?,?,?,?,?,?)").run(id,userId,conversationId,item.name,url,data.length,new Date().toISOString());return{id,name:item.name,url,size:data.length};}))();
}
export function getAssistantAttachment(userId:string,id:string){if(!/^[A-Za-z0-9_-]{1,80}$/.test(userId)||!/^ai-[a-f0-9]{24}$/.test(id))return null;const row=getDb().prepare("SELECT conversation_id,name,size FROM assistant_attachments WHERE user_id=? AND id=?").get(userId,id) as {conversation_id:string;name:string;size:number}|undefined;if(!row||!/^ac-[a-f0-9]{24}$/.test(row.conversation_id))return null;const root=path.join(process.cwd(),"data","assistant-attachments",userId,row.conversation_id);if(!fs.existsSync(root))return null;const file=fs.readdirSync(root).find(name=>name.startsWith(`${id}.`));if(!file || !["jpg","png","gif","webp"].includes(path.extname(file).slice(1)))return null;const info=fs.lstatSync(path.join(root,file));if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)return null;return{...row,file:path.join(root,file),ext:path.extname(file).slice(1)};}
export function deleteConversationAttachments(userId:string,conversationId?:string){
  const rows=(conversationId?getDb().prepare("SELECT url FROM assistant_attachments WHERE user_id=? AND conversation_id=?").all(userId,conversationId):getDb().prepare("SELECT url FROM assistant_attachments WHERE user_id=?").all(userId)) as Array<{url:string}>;
  for(const row of rows){const id=new URL(row.url,"http://local").searchParams.get("id")||"";const attachment=getAssistantAttachment(userId,id);if(attachment)try{fs.unlinkSync(attachment.file);}catch{}}
  if(conversationId)getDb().prepare("DELETE FROM assistant_attachments WHERE user_id=? AND conversation_id=?").run(userId,conversationId);else getDb().prepare("DELETE FROM assistant_attachments WHERE user_id=?").run(userId);
}
