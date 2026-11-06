import { NextResponse } from "next/server";
import { getAuthUser, isAdmin, listUsers } from "@/lib/auth";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  return NextResponse.json({ users: listUsers(), me: user.id });
}
