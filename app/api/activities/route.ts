import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { listActivities } from "@/lib/store";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ activities: listActivities(user.id) });
}
