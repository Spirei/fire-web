import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { clientIp } from "@/lib/rateLimit";

export function logSecurityEvent(request: Request, userId: string, event: string, detail = "") {
  try {
    getDb().prepare(
      "INSERT INTO security_audit (id,user_id,event,detail,ip,created_at) VALUES (?,?,?,?,?,?)"
    ).run(
      `sec-${randomBytes(10).toString("hex")}`,
      userId,
      event.slice(0, 80),
      detail.slice(0, 2000),
      clientIp(request).slice(0, 64),
      new Date().toISOString()
    );
  } catch {
    /* 审计日志失败不应泄露细节或掩盖主操作结果 */
  }
}
