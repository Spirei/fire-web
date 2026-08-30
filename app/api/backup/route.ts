import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getBackupConfig, listBackups, maybeRunBackup, runBackup, saveBackupConfig } from "@/lib/backup";

export const dynamic = "force-dynamic";

function guard(request: Request): NextResponse | null {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  return null;
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  maybeRunBackup(); // 顺带触发一次计划检查
  return NextResponse.json({
    config: getBackupConfig(),
    backups: listBackups()
  });
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const result = await runBackup();
    return NextResponse.json({ ok: true, ...result, backups: listBackups() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "备份失败" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : undefined;
  const intervalHours = Number(body?.intervalHours);
  const keep = Number(body?.keep);
  if (enabled === undefined || !Number.isFinite(intervalHours) || intervalHours <= 0 || !Number.isFinite(keep) || keep <= 0) {
    return NextResponse.json({ error: "备份配置无效" }, { status: 400 });
  }
  const cfg = saveBackupConfig({
    ...getBackupConfig(),
    enabled,
    intervalHours: Math.round(intervalHours),
    keep: Math.min(90, Math.round(keep))
  });
  return NextResponse.json({ ok: true, config: cfg });
}
