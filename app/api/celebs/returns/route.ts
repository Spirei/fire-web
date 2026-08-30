import { NextResponse } from "next/server";
import { getReturnsDaily } from "@/lib/celebsData";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("celeb") ?? "";
  if (!id) return NextResponse.json({ error: "缺少 celeb 参数" }, { status: 400 });
  try {
    return NextResponse.json(getReturnsDaily(id));
  } catch {
    return NextResponse.json({ error: "获取收益数据失败" }, { status: 500 });
  }
}
