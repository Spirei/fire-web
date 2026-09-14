import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";

const MIME_EXT:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","image/avif":"avif","image/svg+xml":"svg"};
export function saveAssistantAttachments(userId:string,conversationId:string,items:Array<{name:string;dataUrl:string}>){
  if(!/^ac-[a-f0-9]{24}$/.test(conversationId)) throw new Error("会话标识无效");
  let total=0;
  const parsed=items.map(item=>{const match=item.dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);if(!match)throw new Error("图片数据无效");const data=Buffer.from(match[2],"base64");total+=data.length;return {name:String(item.name||"图片").slice(0,120),mime:match[1].toLowerCase(),data};});
  if(total>100*1024*1024)throw new Error("图片总大小不能超过 100MB");
  const root=path.join(process.cwd(),"data","assistant-attachments",userId,conversationId);fs.mkdirSync(root,{recursive:true});
  return getDb().transaction(()=>parsed.map(item=>{const id=`ai-${randomBytes(12).toString("hex")}`;const ext=MIME_EXT[item.mime]||item.mime.slice(6).replace(/[^a-z0-9]/g,"").slice(0,12)||"bin";let data=item.data;if(ext==="svg"){let text=data.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/\son\w+\s*=\s*([\"']).*?\1/gi,"").replace(/(?:javascript:|data:text\/html)/gi,"");data=Buffer.from(text);}const file=`${id}.${ext}`;fs.writeFileSync(path.join(root,file),data,{mode:0o600});const url=`/api/assistant/attachments?id=${id}`;getDb().prepare("INSERT INTO assistant_attachments(id,user_id,conversation_id,name,url,size,created_at) VALUES(?,?,?,?,?,?,?)").run(id,userId,conversationId,item.name,url,data.length,new Date().toISOString());return{id,name:item.name,url,size:data.length};}))();
}
export function getAssistantAttachment(userId:string,id:string){const row=getDb().prepare("SELECT conversation_id,name,size FROM assistant_attachments WHERE user_id=? AND id=?").get(userId,id) as {conversation_id:string;name:string;size:number}|undefined;if(!row)return null;const root=path.join(process.cwd(),"data","assistant-attachments",userId,row.conversation_id);const file=fs.readdirSync(root).find(name=>name.startsWith(`${id}.`));if(!file)return null;return{...row,file:path.join(root,file),ext:path.extname(file).slice(1)};}
export function deleteConversationAttachments(userId:string,conversationId?:string){
  const rows=(conversationId?getDb().prepare("SELECT url FROM assistant_attachments WHERE user_id=? AND conversation_id=?").all(userId,conversationId):getDb().prepare("SELECT url FROM assistant_attachments WHERE user_id=?").all(userId)) as Array<{url:string}>;
  for(const row of rows){const id=new URL(row.url,"http://local").searchParams.get("id")||"";const attachment=getAssistantAttachment(userId,id);if(attachment)try{fs.unlinkSync(attachment.file);}catch{}}
  if(conversationId)getDb().prepare("DELETE FROM assistant_attachments WHERE user_id=? AND conversation_id=?").run(userId,conversationId);else getDb().prepare("DELETE FROM assistant_attachments WHERE user_id=?").run(userId);
}
