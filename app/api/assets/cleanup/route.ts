import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { cleanupOrphanFiles, organizeAssetFiles } from "@/lib/fileCleanup";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  // 先归类根目录历史素材文件，再清理孤立文件（引用已随迁移更新）
  const moved = organizeAssetFiles();
  const result = cleanupOrphanFiles();
  return NextResponse.json({ ...result, moved });
}
