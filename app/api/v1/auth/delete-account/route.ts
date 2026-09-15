import { readJsonBody } from "@/lib/requestBody";
import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import fs from "fs";
import path from "path";
import { findUserById } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export const dynamic = "force-dynamic";

/** v1 注销当前账号：级联删除该用户的 sessions/records/trade_orders/activities/watch_groups/user_settings，并尽量删除其头像文件；保护最后一个管理员 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`delete-account:${clientIp(request)}:${user.id}`, 5, 60 * 60 * 1000) || !rateLimitGlobal("delete-account", 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }
  const body = await readJsonBody(request, 16 * 1024).catch(() => null);
  const rowWithPassword = findUserById(user.id);
  if (!rowWithPassword || !verifyPassword(String(body?.password ?? ""), rowWithPassword.password_hash)) {
    logSecurityEvent(request, user.id, "account_delete_rejected", "password verification failed");
    return NextResponse.json({ error: "当前密码错误" }, { status: 403 });
  }
  const db = getDb();
  const adminCount = (db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get() as { n: number }).n;
  if (user.role === "admin" && adminCount <= 1) return NextResponse.json({ error: "不能删除最后一个管理员账号" }, { status: 400 });
  const row = db.prepare("SELECT avatar FROM users WHERE id = ?").get(user.id) as { avatar?: string } | undefined;
  try {
    if (row?.avatar && row.avatar.startsWith("/uploads/")) {
      const uploadsRoot = path.resolve(process.cwd(), "public", "uploads");
      const abs = path.resolve(process.cwd(), "public", row.avatar.replace(/^\/+/, ""));
      if (abs.startsWith(uploadsRoot + path.sep) && fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  } catch {
    /* 头像文件删除失败不阻断 */
  }
  logSecurityEvent(request, user.id, "account_delete", "verified deletion");
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  return NextResponse.json({ ok: true });
}
