import { NextResponse } from "next/server";

const SOURCE = "https://trumpstruth.org/";

function clean(value: string) {
  return value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
}

export async function GET() {
  try {
    const response = await fetch(SOURCE, { headers: { "User-Agent": "Fire/1.0 public archive reader" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`archive ${response.status}`);
    const html = await response.text();
    const posts = [...html.matchAll(/<div class="status"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g)].map((match, index) => {
      const block = match[0];
      const date = block.match(/status-info__meta-item">([^<]+,\s*\d{4},\s*[^<]+)</)?.[1] ?? "";
      const originalUrl = block.match(/href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/[^" ]+)"/)?.[1] ?? "https://truthsocial.com/@realDonaldTrump";
      const content = clean(block.match(/<div class="status__content">([\s\S]*?)<\/div>/)?.[1] ?? "");
      const archiveUrl = block.match(/data-status-url="([^" ]+)/)?.[1] ?? SOURCE;
      return { id: archiveUrl.split("/").pop() || String(index), date, text: content, originalUrl, archiveUrl: archiveUrl.startsWith("http") ? archiveUrl : `https://trumpstruth.org/statuses/${archiveUrl}` };
    }).filter((post) => post.text && post.date);
    const cutoff = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const recent = posts.filter((post) => Date.parse(post.date) >= cutoff);
    return NextResponse.json({ posts: recent.length ? recent : posts, source: SOURCE, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ posts: [], source: SOURCE, fetchedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "archive unavailable" }, { status: 502 });
  }
}
