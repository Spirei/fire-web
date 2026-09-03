import path from "node:path";
import { getSiteSettings } from "@/lib/settings";
import { readJsonFile, writeJsonAtomic } from "@/lib/tradingSquareCache";
import { hasTranslatableText } from "@/lib/tradingSquareText";

const TRANSLATIONS = path.join(process.cwd(), "data", "trump-translations.json");

export function validTranslation(value?: string) {
  if (!value) return false;
  if (/MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS|QUOTA|RATE LIMIT/i.test(value)) return false;
  if (/请提供|需要翻译的英文|请直接提供|无法访问外部链接|没有需要翻译|无可翻译|please provide|no (?:english )?text to translate|cannot access (?:the )?external links/i.test(value)) return false;
  return true;
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
let llmCooldownUntil = 0;
let memoryCooldownUntil = 0;

function llmKey(): string {
  const settings = getSiteSettings();
  return (settings.llmApiKey || settings.deepseekApiKey || process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "").trim();
}

async function translateWithLlm(text: string): Promise<string | undefined> {
  if (Date.now() < llmCooldownUntil) return undefined;
  const key = llmKey();
  if (!key) return undefined;
  const settings = getSiteSettings();
  const translation = await fetch(settings.llmApiUrl || settings.deepseekApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
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
    llmCooldownUntil = Date.now() + 10 * 60 * 1000;
    return undefined;
  }
  if (!translation.ok) return undefined;
  const data = await translation.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim();
}

async function translateWithMyMemory(text: string): Promise<string | undefined> {
  if (Date.now() < memoryCooldownUntil) return undefined;
  const settings = getSiteSettings();
  const translation = await fetch(
    `${settings.translationApiUrl}?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|zh-CN`,
    { signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } }
  );
  if (translation.status === 429) {
    memoryCooldownUntil = Date.now() + 10 * 60 * 1000;
    return undefined;
  }
  if (!translation.ok) return undefined;
  const data = await translation.json() as { responseData?: { translatedText?: string } };
  return data.responseData?.translatedText || undefined;
}

/** 大模型优先，失败或未配置时再走 MyMemory。 */
async function translateOne(text: string): Promise<string | undefined> {
  if (!hasTranslatableText(text)) return undefined;
  const settings = getSiteSettings();
  if (!settings.translationEnabled) return undefined;
  try {
    const llm = await translateWithLlm(text);
    if (llm && validTranslation(llm)) return llm;
  } catch {
    /* fall through to MyMemory */
  }
  try {
    const fallback = await translateWithMyMemory(text);
    if (fallback && validTranslation(fallback)) return fallback;
  } catch {
    return undefined;
  }
  return undefined;
}

async function acquireBackfill(timeoutMs = 35_000): Promise<boolean> {
  const start = Date.now();
  while (backfillRunning) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  backfillRunning = true;
  return true;
}

function applyTranslations<T extends { id: string; text: string }>(posts: T[], translations: Record<string, string>): T[] {
  return posts.map((post) => {
    if (!hasTranslatableText(post.text)) {
      const next = { ...post } as T & { textZh?: string };
      delete next.textZh;
      return next;
    }
    return validTranslation(translations[post.id]) ? { ...post, textZh: translations[post.id] } : post;
  });
}

async function translateMissing<T extends { id: string; text: string }>(
  posts: T[],
  limit: number,
  opts: { skipCooldown?: boolean; deadlineMs?: number }
): Promise<number> {
  const translations = readTranslations();
  const now = Date.now();
  let purged = false;
  posts.forEach((post) => {
    if (!hasTranslatableText(post.text) || (translations[post.id] && !validTranslation(translations[post.id]))) {
      if (translations[post.id]) {
        delete translations[post.id];
        purged = true;
      }
    }
  });
  if (purged) writeTranslations(translations);
  const missing = posts.filter((post) => {
    if (!hasTranslatableText(post.text)) return false;
    if (validTranslation(translations[post.id])) return false;
    if (opts.skipCooldown) return true;
    const failedAt = recentlyFailed.get(post.id) ?? 0;
    return now - failedAt >= FAILED_COOLDOWN_MS;
  });
  const deadline = now + (opts.deadlineMs ?? 25_000);
  let saved = 0;
  for (let index = 0; index < missing.length && saved < limit && Date.now() < deadline; index += 3) {
    const batch = missing.slice(index, index + 3);
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
  return saved;
}

/** 新帖优先：等锁、译完再返回，调用方随后才写入本地 JSON。 */
export async function translateTrumpPostsNow<T extends { id: string; text: string }>(posts: T[]): Promise<T[]> {
  if (!posts.length) return posts;
  const got = await acquireBackfill(40_000);
  if (!got) return applyTranslations(posts, readTranslations());
  try {
    await translateMissing(posts, posts.length, { skipCooldown: true, deadlineMs: 40_000 });
  } finally {
    backfillRunning = false;
  }
  return applyTranslations(posts, readTranslations());
}

/** 翻译尚未有中文的历史帖子。失败的条目冷却后重试，不挡住队列。 */
export async function backfillTrumpTranslations<T extends { id: string; text: string }>(
  posts: T[],
  limit = 20
): Promise<T[]> {
  const translations = readTranslations();
  if (limit <= 0) return applyTranslations(posts, translations);
  const got = await acquireBackfill(5_000);
  if (!got) return applyTranslations(posts, translations);
  try {
    await translateMissing(posts, limit, { deadlineMs: 25_000 });
  } finally {
    backfillRunning = false;
  }
  return applyTranslations(posts, readTranslations());
}
