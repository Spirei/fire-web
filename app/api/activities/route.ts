import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { listActivities, listSystemLogs } from "@/lib/store";
import { listOrders } from "@/lib/orders";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json({ activities: listActivities(user.id), orders: listOrders(user.id, "all", 100), systemLogs: isAdmin(user) ? listSystemLogs() : [] });
}
