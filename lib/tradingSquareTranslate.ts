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
const FAILED_COOLDOWN_MS = 30 * 60 * 1000;
const recentlyFailed = new Map<string, number>();
let providerCooldownUntil = 0;

async function translateOne(text: string): Promise<string | undefined> {
  if (Date.now() < providerCooldownUntil) return undefined;
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
      signal: AbortSignal.timeout(12000),
      cache: "no-store"
    });
    if (translation.status === 429) {
      providerCooldownUntil = Date.now() + 10 * 60 * 1000;
      return undefined;
    }
    const data = await translation.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim();
  }
  const translation = await fetch(
    `${settings.translationApiUrl}?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|zh-CN`,
    { signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } }
  );
  if (translation.status === 429) {
    providerCooldownUntil = Date.now() + 10 * 60 * 1000;
    return undefined;
  }
  const data = await translation.json() as { responseData?: { translatedText?: string } };
  return data.responseData?.translatedText || undefined;
}

function applyTranslations<T extends { id: string; text: string }>(posts: T[], translations: Record<string, string>): T[] {
  return posts.map((post) => validTranslation(translations[post.id]) ? { ...post, textZh: translations[post.id] } : post);
}

/** 翻译尚未有中文的帖子。失败的条目冷却后重试，不挡住更早的未译队列。 */
export async function backfillTrumpTranslations<T extends { id: string; text: string }>(
  posts: T[],
  limit = 20
): Promise<T[]> {
  const translations = readTranslations();
  if (backfillRunning || limit <= 0) return applyTranslations(posts, translations);
  backfillRunning = true;
  const now = Date.now();
  const missing = posts.filter((post) => {
    if (validTranslation(translations[post.id])) return false;
    const failedAt = recentlyFailed.get(post.id) ?? 0;
    return now - failedAt >= FAILED_COOLDOWN_MS;
  });
  try {
    const deadline = now + 25_000;
    let saved = 0;
    for (let index = 0; index < missing.length && saved < limit && Date.now() < deadline; index += 4) {
      const batch = missing.slice(index, index + 4);
      await Promise.all(batch.map(async (post) => {
        try {
          const textZh = await translateOne(post.text);
          if (textZh && validTranslation(textZh)) {
            translations[post.id] = textZh;
            recentlyFailed.delete(post.id);
            saved += 1;
          } else {
            recentlyFailed.set(post.id, Date.now());
          }
        } catch {
          recentlyFailed.set(post.id, Date.now());
        }
      }));
      if (saved) writeTranslations(translations);
    }
  } finally {
    backfillRunning = false;
  }
  return applyTranslations(posts, readTranslations());
}
