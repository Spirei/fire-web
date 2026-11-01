import { randomBytes } from "node:crypto";
import { getDb } from "./db";

// 动态页沿用原用量表，保留已有调用记录。
export function logModelUsage(value: { userId:string; conversationId?:string; serviceId:string; serviceName:string; model:string; status:string; latencyMs:number; promptTokens?:number; completionTokens?:number; estimatedCost?:number; error?:string; turnId?:string; attemptIndex?:number; firstTokenMs?:number; imageCount?:number; dataScope?:string }) {
  const database=getDb();
  database.transaction(()=>{
    database.prepare("DELETE FROM assistant_usage WHERE created_at < ?").run(new Date(Date.now()-30*24*60*60*1000).toISOString());
    database.prepare("INSERT INTO assistant_usage(id,user_id,conversation_id,service_id,service_name,model,status,latency_ms,prompt_tokens,completion_tokens,estimated_cost,error,turn_id,attempt_index,first_token_ms,image_count,data_scope,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`au-${randomBytes(12).toString("hex")}`,value.userId,value.conversationId||"",value.serviceId,value.serviceName,value.model,value.status,value.latencyMs,value.promptTokens||0,value.completionTokens||0,value.estimatedCost||0,(value.error||"").slice(0,120),(value.turnId||"").slice(0,40),Math.max(0,value.attemptIndex||0),Math.max(0,value.firstTokenMs||0),Math.max(0,value.imageCount||0),["none","page","account","feed"].includes(value.dataScope||"")?value.dataScope:"none",new Date().toISOString());
  })();
}
