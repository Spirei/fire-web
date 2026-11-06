import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { readPersonalActivity } from "@/lib/apiRequestLog";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = request.headers.has("authorization")
    ? null
    : getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  return NextResponse.json(readPersonalActivity(user.id), {
    headers: { "Cache-Control": "no-store, private" },
  });
}
