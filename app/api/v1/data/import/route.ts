import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { validateBackupAccess, validateBackupPayload, restoreBackupPayload } from "@/lib/dataTransfer";
import { runBackup } from "@/lib/backup";
import { clientIp, rateLimit, rateLimitGlobal } from "@/lib/rateLimit";
import { logSecurityEvent } from "@/lib/securityAudit";

export const dynamic = "force-dynamic";
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** v1 网站数据导入：单事务 upsert 还原；导入前先做一次数据库快照备份。普通用户仅能影响自身数据，站点设置/名人持仓仅管理员写入 */
export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!rateLimit(`data-import:${clientIp(request)}:${user.id}`, 10, 60 * 60 * 1000) || !rateLimitGlobal("data-import", 100, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "导入过于频繁，请稍后再试" }, { status: 429 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMPORT_BYTES) return NextResponse.json({ error: "备份文件超过 10MB 限制" }, { status: 413 });
  const raw = await request.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) return NextResponse.json({ error: "备份文件超过 10MB 限制" }, { status: 413 });
  let body: unknown = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  try {
    const check = validateBackupPayload(body);
    validateBackupAccess(body, user.id, user.role === "admin");
    if (preview) {
      logSecurityEvent(request, user.id, "data_import_preview", JSON.stringify(check.counts));
      return NextResponse.json({ ok: true, preview: true, counts: check.counts }, { headers: { "Cache-Control": "no-store" } });
    }
    // 导入前先备份当前数据库，避免意外
    try {
      await runBackup();
    } catch {
      logSecurityEvent(request, user.id, "data_import_blocked", "pre-import backup failed");
      return NextResponse.json({ error: "导入前安全备份失败，已停止导入" }, { status: 503 });
    }
    const result = restoreBackupPayload(body, user.id, user.role === "admin");
    logSecurityEvent(request, user.id, "data_import", JSON.stringify(result.counts));
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logSecurityEvent(request, user.id, "data_import_rejected", err instanceof Error ? err.message : "invalid payload");
    const message = err instanceof Error && /^(不是有效|备份|站点设置|订单引用|profile\.|records\.|tradeOrders\.|activities\.|watchGroups\.|userSettings\.|celebs\.)/.test(err.message)
      ? err.message
      : "备份文件校验失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
