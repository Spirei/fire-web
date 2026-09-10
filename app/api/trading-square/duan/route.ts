import { NextRequest, NextResponse } from "next/server";
import { DUAN_CACHE_LIMIT, takeNewest } from "@/lib/tradingSquareLimits";
import { readDuanPosts, refreshDuanPosts } from "@/lib/tradingSquareRefresh";

const USER = { id: "1247347556", handle: "slowisquick", name: "大道无形我有型" };

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const posts = takeNewest(forceRefresh ? await refreshDuanPosts() : readDuanPosts(), DUAN_CACHE_LIMIT);
  return NextResponse.json({ posts, user: USER, source: forceRefresh ? "live" : "cache" });
}
