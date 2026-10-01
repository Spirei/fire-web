import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getRatesSnapshot } from "@/lib/rates";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json(await getRatesSnapshot(force), { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return NextResponse.json({ error: "获取汇率失败，请稍后重试" }, { status: 502 });
  }
}
