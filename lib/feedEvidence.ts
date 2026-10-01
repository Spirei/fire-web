import { proxyFetch } from "./net";
import { readLimitedResponseBytes } from "./requestBody";
import type { FeedSource } from "./feedTypes";
import { sourceUrl } from "./feedStore";
import type { FeedMedia } from "./feedTypes";
import { fetchPublicFeedDocument } from "./feedPublicFetch";

// Exact public primary publishers only. No arbitrary crawl, credentials, redirects or private hosts.
const PRIMARY_ORIGINS = new Set([
  "https://www.sec.gov", "https://investors.micron.com", "https://micron.gcs-web.com",
  "https://investor.nvidia.com", "https://investor.apple.com", "https://www.microsoft.com",
  "https://ir.aboutamazon.com", "https://investor.atmeta.com", "https://ir.tesla.com",
  "https://investors.broadcom.com", "https://investor.accenture.com", "https://newsroom.accenture.com"
]);
const plain = (html: string) => html.replace(/<!--[^]*?-->/g, " ").replace(/<(script|style|svg|nav|header|footer)\b[^>]*>[^]*?<\/\1>/gi, " ")
  .replace(/<[^>]*>/g, " ").replace(/&#(x[\da-f]+|\d+);/gi, (_m, n) => { const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " "; })
  .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/g, v => ({ "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" }[v]!))
  .replace(/\s+/g, " ").trim();

function attributes(tag: string) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), plain(m[2] ?? m[3])]));
}
export function parsePrimaryFeedArticle(html: string, pageUrl?: string): { excerpt: string; publishedAt: string | null; media: FeedMedia[] } | null {
  const article = html.match(/<article\b[^>]*>([^]*?)<\/article>/i)?.[1] || html.match(/<main\b[^>]*>([^]*?)<\/main>/i)?.[1];
  if (!article) return null; // Challenge/login pages and navigation are not evidence.
  const excerpt = plain(article).slice(0, 16_000);
  if (excerpt.length < 120) return null;
  const meta = new Map([...html.matchAll(/<meta\b[^>]{0,3000}>/gi)].map(m => { const a=attributes(m[0]); return [a.property || a.name, a.content]; }));
  const declared = meta.get("article:published_time") || meta.get("datePublished") || meta.get("pubdate")
    || article.match(/field--name-field-nir-(?:publish-date|news-date)[^]*?field__item[^>]*>([^<]+)/i)?.[1];
  const t = declared ? Date.parse(plain(declared).replace(/ at /, " ")) : NaN;
  const media: FeedMedia[] = [], seen=new Set<string>();
  const add=(type:FeedMedia["type"],raw:string|undefined,alt="报道配图",poster?:string)=>{
    if(!raw || !pageUrl || media.length>=3)return;
    try {
      const url=sourceUrl(new URL(raw,pageUrl).href);if(!url||seen.has(url)||/\.(?:svg|gif)(?:\?|$)/i.test(url))return;
      if(type==="image"&&/(?:logo|favicon|tracking|pixel|avatar|icon)[\W_]/i.test(new URL(url).pathname))return;
      if(type==="video"&&!/\.(?:mp4|webm)(?:\?|$)/i.test(url)&&!/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\//.test(url))return;
      seen.add(url);media.push({type,url,alt:alt.slice(0,160),...(poster&&sourceUrl(poster)?{poster:sourceUrl(poster)!}:{}),...(type==="video"&&!/\.(?:mp4|webm)(?:\?|$)/i.test(url)?{playback:"external" as const}:{})});
    }catch{/* Invalid or private resource is never persisted. */}
  };
  // Prefer actual article photos; metadata is only a fallback, not site logos.
  for(const m of article.matchAll(/<img\b[^>]{0,3000}>/gi)){const a=attributes(m[0]);if(Number(a.width||200)<100||Number(a.height||200)<100)continue;add("image",a.src||a["data-src"],a.alt||"报道配图");if(media.length>=2)break;}
  if(!media.length)add("image",meta.get("og:image")||meta.get("twitter:image"));
  const video=article.match(/<video\b[^>]{0,3000}>[^]*?<\/video>/i)?.[0];
  if(video){const a=attributes(video.match(/^<[^>]+>/)![0]),s=attributes(video.match(/<source\b[^>]{0,3000}>/i)?.[0]||"");add("video",a.src||s.src,"报道视频",a.poster);}
  else add("video",meta.get("og:video:secure_url")||meta.get("og:video:url")||meta.get("og:video"),"报道视频",media[0]?.url);
  return { excerpt, publishedAt: Number.isFinite(t) && t <= Date.now() + 60_000 ? new Date(t).toISOString() : null, media };
}

export async function enrichFeedEvidence(sources: FeedSource[]): Promise<FeedSource[]> {
  const origins = new Set<string>();
  const candidates = sources.filter(source => {
    const origin = new URL(source.url).origin;
    if (origins.has(origin)) return false;
    origins.add(origin); return true;
  }).slice(0, 4);
  const enriched = new Map<string, ReturnType<typeof parsePrimaryFeedArticle>>();
  await Promise.all(candidates.map(async source => {
    try {
      if(!PRIMARY_ORIGINS.has(new URL(source.url).origin)){
        const doc=await fetchPublicFeedDocument(source.url);if(doc.contentType.includes("html"))enriched.set(source.id,parsePrimaryFeedArticle(doc.text,doc.url));return;
      }
      const response = await proxyFetch(source.url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8_000), headers: { Accept: "text/html", "User-Agent": "AlcorNewsReader/1.0" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
      enriched.set(source.id, parsePrimaryFeedArticle(new TextDecoder().decode(await readLimitedResponseBytes(response, 1_500_000)),source.url));
    } catch { /* An unavailable primary page does not turn search snippets into a full article. */ }
  }));
  return sources.map(source => {
    const article = enriched.get(source.id);
    return article ? { ...source, excerpt: article.excerpt, evidence:"publisher-page", media:article.media.length?article.media:source.media, publishedAt: article.publishedAt || source.publishedAt } : source;
  });
}
