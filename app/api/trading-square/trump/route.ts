import { NextResponse } from "next/server";
import { getSiteSettings } from "@/lib/settings";
import fs from "node:fs";
import path from "node:path";

const SOURCE = "https://trumpstruth.org/";
const CACHE_FILE = path.join(process.cwd(), "data", "trump-translations.json");
function readTranslations(): Record<string, string> { try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; } }
function writeTranslations(cache: Record<string, string>) { try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch { /* read-only deployments still work without persistence */ } }
function validTranslation(value?: string) { return !!value && !/MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS|QUOTA|RATE LIMIT/i.test(value); }

function clean(value: string) {
  return value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
}

export async function GET() {
  try {
    const settings = getSiteSettings();
    const source = settings.trumpArchiveApiUrl || SOURCE;
    let html = "";
    let nextUrl = source;
    for (let page = 0; page < 1 && nextUrl; page += 1) {
      const response = await fetch(nextUrl, { headers: { "User-Agent": "Fire/1.0 public archive reader" }, next: { revalidate: 60 }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`archive ${response.status}`);
      const pageHtml = await response.text();
      html += pageHtml;
      const next = pageHtml.match(/<a href="([^"]*cursor=[^"]+)"[^>]*>Next Page/i)?.[1];
      nextUrl = next ? new URL(next.replace(/&amp;/g, "&"), source).toString() : "";
    }
    const posts = html.split('<div class="status"').slice(1).map((tail, index) => {
      const block = tail.split('<div class="status"')[0];
      const date = block.match(/status-info__meta-item">([^<]+,\s*\d{4},\s*[^<]+)</)?.[1] ?? "";
      const originalUrl = block.match(/href="(https:\/\/truthsocial\.com\/@realDonaldTrump\/[^" ]+)"/)?.[1] ?? "https://truthsocial.com/@realDonaldTrump";
      const content = clean(block.match(/<div class="status__content">([\s\S]*?)<\/div>/)?.[1] ?? "");
      const archiveUrl = block.match(/data-status-url="([^" ]+)/)?.[1] ?? SOURCE;
      return { id: archiveUrl.split("/").pop() || String(index), date, text: content, originalUrl, archiveUrl: archiveUrl.startsWith("http") ? archiveUrl : `https://trumpstruth.org/statuses/${archiveUrl}` };
    }).filter((post) => post.text && post.date);
    const cutoff = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const recent = posts.filter((post) => Date.parse(post.date) >= cutoff).slice(0, 100);
    const translations = readTranslations();
    const localized = await Promise.all(recent.map(async (post, index) => {
      if (validTranslation(translations[post.id])) return { ...post, textZh: translations[post.id] };
      delete translations[post.id];
      if (index >= 3) return post;
      try {
        if (!settings.translationEnabled) return post;
        let textZh: string | undefined;
        if (settings.llmApiKey || settings.deepseekApiKey) {
          const translation = await fetch(settings.llmApiUrl || settings.deepseekApiUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.llmApiKey || settings.deepseekApiKey}` }, body: JSON.stringify({ model: settings.llmModel || settings.deepseekModel || "deepseek-chat", temperature: 0.1, messages: [{ role: "system", content: "将用户提供的英文社交媒体内容准确翻译为简体中文，只输出译文，不添加解释。" }, { role: "user", content: post.text.slice(0, 4000) }] }), signal: AbortSignal.timeout(8000), cache: "no-store" });
          const data = await translation.json() as { choices?: Array<{ message?: { content?: string } }> };
          textZh = data.choices?.[0]?.message?.content?.trim();
        } else {
          const translation = await fetch(`${settings.translationApiUrl}?q=${encodeURIComponent(post.text.slice(0, 480))}&langpair=en|zh-CN`, { signal: AbortSignal.timeout(1800), next: { revalidate: 3600 } });
          const data = await translation.json() as { responseData?: { translatedText?: string } };
          textZh = data.responseData?.translatedText || undefined;
        }
        if (validTranslation(textZh)) { translations[post.id] = textZh; writeTranslations(translations); return { ...post, textZh }; }
        return post;
      } catch { return post; }
    }));
    return NextResponse.json({ posts: localized, source: SOURCE, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ posts: [], source: SOURCE, fetchedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "archive unavailable" }, { status: 502 });
  }
}
