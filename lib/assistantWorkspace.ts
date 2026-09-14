import { randomBytes } from "node:crypto";
import { getDb } from "./db";

export function listAssistantSpaces(userId: string) {
  return getDb().prepare("SELECT id,name,created_at AS createdAt FROM assistant_spaces WHERE user_id=? ORDER BY created_at").all(userId);
}
export function listConversationSpaces(userId:string){return Object.fromEntries((getDb().prepare("SELECT conversation_id,space_id FROM assistant_conversation_spaces WHERE user_id=?").all(userId) as Array<{conversation_id:string;space_id:string}>).map(row=>[row.conversation_id,row.space_id]));}
export function createAssistantSpace(userId: string, name: unknown) {
  const safe = String(name || "").trim().slice(0, 40);
  if (!safe) throw new Error("空间名称不能为空");
  const id = `as-${randomBytes(8).toString("hex")}`;
  getDb().prepare("INSERT INTO assistant_spaces(id,user_id,name,created_at) VALUES(?,?,?,?)").run(id,userId,safe,new Date().toISOString());
  return { id, name: safe };
}
export function deleteAssistantSpace(userId: string, id: string) {
  getDb().transaction(() => {
    getDb().prepare("UPDATE assistant_conversation_spaces SET space_id='' WHERE user_id=? AND space_id=?").run(userId,id);
    getDb().prepare("DELETE FROM assistant_spaces WHERE user_id=? AND id=?").run(userId,id);
  })();
}
export function setConversationSpace(userId: string, conversationId: string, spaceId: string) {
  if (spaceId && !getDb().prepare("SELECT 1 FROM assistant_spaces WHERE user_id=? AND id=?").get(userId,spaceId)) throw new Error("空间不存在");
  getDb().prepare("INSERT INTO assistant_conversation_spaces(user_id,conversation_id,space_id) VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET space_id=excluded.space_id").run(userId,conversationId,spaceId);
}
export function conversationSpace(userId: string, conversationId: string) {
  return (getDb().prepare("SELECT space_id FROM assistant_conversation_spaces WHERE user_id=? AND conversation_id=?").get(userId,conversationId) as {space_id:string}|undefined)?.space_id || "";
}

export function logAssistantUsage(value: { userId:string; conversationId?:string; serviceId:string; serviceName:string; model:string; status:string; latencyMs:number; promptTokens?:number; completionTokens?:number; estimatedCost?:number; error?:string }) {
  getDb().prepare("INSERT INTO assistant_usage(id,user_id,conversation_id,service_id,service_name,model,status,latency_ms,prompt_tokens,completion_tokens,estimated_cost,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`au-${randomBytes(12).toString("hex")}`,value.userId,value.conversationId||"",value.serviceId,value.serviceName,value.model,value.status,value.latencyMs,value.promptTokens||0,value.completionTokens||0,value.estimatedCost||0,(value.error||"").slice(0,120),new Date().toISOString());
}
export function assistantUsage(userId:string) {
  const rows=getDb().prepare("SELECT service_name AS serviceName,model,status,latency_ms AS latencyMs,prompt_tokens AS promptTokens,completion_tokens AS completionTokens,estimated_cost AS estimatedCost,error,created_at AS createdAt FROM assistant_usage WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(userId) as Array<Record<string,unknown>>;
  return { rows, summary: rows.reduce<{calls:number;errors:number;tokens:number;cost:number}>((s,r)=>({calls:s.calls+1,errors:s.errors+(r.status==='ok'?0:1),tokens:s.tokens+Number(r.promptTokens||0)+Number(r.completionTokens||0),cost:s.cost+Number(r.estimatedCost||0)}),{calls:0,errors:0,tokens:0,cost:0}) };
}
