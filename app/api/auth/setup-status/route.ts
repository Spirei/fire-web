import { NextResponse } from "next/server";
import { needsSetup } from "@/lib/auth";

/** 公开接口：仅返回当前实例是否还需要首次管理员设置，不泄露用户名或数量。 */
export async function GET() {
  return NextResponse.json(
    { needsSetup: needsSetup() },
    { headers: { "Cache-Control": "no-store, private" } }
  );
}
