import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { backfillBoard } from "@/lib/stockSync";

export async function POST(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const result = await backfillBoard();
  return NextResponse.json(result);
}
