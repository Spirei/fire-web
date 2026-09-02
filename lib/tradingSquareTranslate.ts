import path from "node:path";
import { getSiteSettings } from "@/lib/settings";
import { readJsonFile, writeJsonAtomic } from "@/lib/tradingSquareCache";

const TRANSLATIONS = path.join(process.cwd(), "data", "trump-translations.json");

export function validTranslation(value?: string) {
  return !!value && !/MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS|QUOTA|RATE LIMIT/i.test(value);
}

export function readTranslations(): Record<string, string> {
  return readJsonFile<Record<string, string>>(TRANSLATIONS, {});
}

function writeTranslations(cache: Record<string, string>) {
  try { writeJsonAtomic(TRANSLATIONS, cache); } catch { /* read-only deployments still work without persistence */ }
}

let backfillRunning = false;

async function translateOne(text: string): Promise<string | undefined> {
  const settings = getSiteSettings();
  if (!settings.translationEnabled) return undefined;
  if (settings.llmApiKey || settings.deepseekApiKey) {
    const translation = await fetch(settings.llmApiUrl || settings.deepseekApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.llmApiKey || settings.deepseekApiKey}` },
      body: JSON.stringify({
        model: settings.llmModel || settings.deepseekModel || "deepseek-chat",
        temperature: 0.1,
        messages: [
          { role: "system", content: "将用户提供的英文社交媒体内容准确翻译为简体中文，只输出译文，不添加解释。" },
          { role: "user", content: text.slice(0, 4000) }
        ]
      }),
      signal: AbortSignal.timeout(2500),
      cache: "no-store"
    });
    const data = await translation.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim();
  }
  const translation = await fetch(
    `${settings.translationApiUrl}?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|zh-CN`,
    { signal: AbortSignal.timeout(2500), next: { revalidate: 3600 } }
  );
  const data = await translation.json() as { responseData?: { translatedText?: string } };
  return data.responseData?.translatedText || undefined;
}

/** 只翻译尚未有有效中文的帖子，按时间顺序取前 limit 条，不占用已译条目的名额。 */
export async function backfillTrumpTranslations<T extends { id: string; text: string }>(
  posts: T[],
  limit = 3
): Promise<T[]> {
  if (backfillRunning || limit <= 0) {
    const cached = readTranslations();
    return posts.map((post) => validTranslation(cached[post.id]) ? { ...post, textZh: cached[post.id] } : post);
  }
  backfillRunning = true;
  const translations = readTranslations();
  const missing = posts.filter((post) => !validTranslation(translations[post.id])).slice(0, limit);
  try {
    await Promise.all(missing.map(async (post) => {
      try {
        const textZh = await translateOne(post.text);
        if (textZh && validTranslation(textZh)) translations[post.id] = textZh;
      } catch {
        /* keep original text; next visit retries */
      }
    }));
    if (missing.length) writeTranslations(translations);
  } finally {
    backfillRunning = false;
  }
  return posts.map((post) => validTranslation(translations[post.id]) ? { ...post, textZh: translations[post.id] } : post);
}
