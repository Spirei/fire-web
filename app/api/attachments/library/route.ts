import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { listLibraryAssets, queryLibraryAssets } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = getAuthUser(request);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  const { searchParams } = new URL(request.url);
  if (searchParams.get("paged") !== "1") return NextResponse.json(listLibraryAssets());
  return NextResponse.json(
    queryLibraryAssets({
      type: searchParams.get("type") ?? undefined,
      market: searchParams.get("market") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      sort: searchParams.get("sort") ?? undefined,
      page: Number(searchParams.get("page") ?? 1),
      pageSize: Number(searchParams.get("pageSize") ?? 10)
    })
  );
}
