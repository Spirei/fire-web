import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { listSecurityLogs } from "@/lib/store";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({
    userLogs: listSecurityLogs(200, user.id),
    systemLogs: isAdmin(user) ? listSecurityLogs(200) : []
  });
}
