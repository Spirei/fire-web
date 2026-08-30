import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getDbStatus } from "@/lib/db";
import { getSiteSettings } from "@/lib/settings";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const settings = getSiteSettings();
  return NextResponse.json({
    status: {
      ...getDbStatus(),
      configuredType: settings.dbType
    }
  });
}
