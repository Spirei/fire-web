import { NextRequest, NextResponse } from "next/server";
import { TRADING_SQUARE_AUTHOR_LIMIT, takeNewest } from "@/lib/tradingSquareLimits";
import { readDuanPosts, refreshDuanPosts } from "@/lib/tradingSquareRefresh";
import { readDuanComments } from "@/lib/tradingSquareComments";
import { replyTargetFromText } from "@/lib/tradingSquareText";

const USER = { id: "1247347556", handle: "slowisquick", name: "大道无形我有型" };

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const raw = takeNewest(forceRefresh ? await refreshDuanPosts() : readDuanPosts(), TRADING_SQUARE_AUTHOR_LIMIT);
  const commentsByPost = readDuanComments();
  const posts = raw.map((post) => {
    const replyTo = post.replyTo || replyTargetFromText(post.text);
    const comments = commentsByPost[post.id]?.comments;
    return { ...post, ...(replyTo ? { replyTo } : {}), ...(comments?.length ? { comments } : {}) };
  });
  return NextResponse.json({ posts, user: USER, source: forceRefresh ? "live" : "cache" });
}
