import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getSyncStatus, syncStocks } from "@/lib/stockSync";

export async function GET() {
  return NextResponse.json({ status: getSyncStatus() });
}

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  // 支持 body { mode: "icons" }：仅补全缺失图标，不重拉列表（快速修复图标缺失）
  const body = await request.json().catch(() => null);
  const onlyIcons = body?.mode === "icons";
  // 不 await：后台同步，接口立即返回，前端轮询 /api/assets/sync 获取进度
  void syncStocks(onlyIcons);
  return NextResponse.json({ ok: true, message: onlyIcons ? "图标补全已开始" : "股票同步已开始" });
}
