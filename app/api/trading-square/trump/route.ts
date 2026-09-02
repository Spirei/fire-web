import { NextRequest, NextResponse } from "next/server";
import { readTrumpPosts, refreshTrumpPosts } from "@/lib/tradingSquareRefresh";
import { backfillTrumpTranslations, readTranslations, validTranslation } from "@/lib/tradingSquareTranslate";

const SOURCE = "https://trumpstruth.org/";

function withZh(posts: ReturnType<typeof readTrumpPosts>) {
  const translations = readTranslations();
  return posts.map((post) => validTranslation(translations[post.id]) ? { ...post, textZh: translations[post.id] } : post);
}

export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const posts = forceRefresh ? await refreshTrumpPosts() : readTrumpPosts();
    const localized = withZh(posts);
    if (!forceRefresh && posts.length) void backfillTrumpTranslations(posts, 20);
    return NextResponse.json({
      posts: localized,
      source: SOURCE,
      fetchedAt: new Date().toISOString(),
      cached: !forceRefresh
    });
  } catch (error) {
    const fallback = withZh(readTrumpPosts());
    if (fallback.length) {
      return NextResponse.json({ posts: fallback, source: SOURCE, fetchedAt: new Date().toISOString(), cached: true, stale: true });
    }
    return NextResponse.json({ posts: [], source: SOURCE, fetchedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "archive unavailable" }, { status: 502 });
  }
}
