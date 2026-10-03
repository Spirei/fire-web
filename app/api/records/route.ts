import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { clearAllRecords } from "@/lib/store";
import { recordsResponse } from "@/lib/recordsApi";
import { findUserById } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export function GET(request: Request) { return recordsResponse(request, "list", undefined, true); }
export function POST(request: Request) { return recordsResponse(request, "list", undefined, true); }

export async function DELETE(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`clear-records:${clientIp(request)}:${user.id}`, 5, 60 * 60 * 1000) || !rateLimitGlobal("clear-records", 50, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request).catch(() => null);
  const row = findUserById(user.id);
  if (!row || !verifyPassword(String(body?.password ?? ""), row.password_hash)) {
    logSecurityEvent(request, user.id, "records_clear_rejected", "password verification failed");
    return NextResponse.json({ error: "当前密码错误" }, { status: 403 });
  }
  const cleared = clearAllRecords(user.id);
  logSecurityEvent(request, user.id, "records_clear", JSON.stringify(cleared));
  return NextResponse.json({ ok: true, ...cleared });
}
