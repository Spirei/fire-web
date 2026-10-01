/** Shared JSON contract: Web and native clients never need to parse rendered HTML. */
export const FEED_ICONS = ["market", "chart", "world", "technology", "idea", "note", "security", "time", "conversation", "magic", "image", "palette", "check"] as const;
export type FeedIcon = typeof FEED_ICONS[number];
export type FeedSource = { id: string; title: string; url: string; publisher: string; publishedAt: string | null; excerpt: string };
export type FeedSegment = { text: string; sourceId?: string };
export type FeedPost = {
  id: string; title: string; icon: FeedIcon; segments: FeedSegment[]; sources: FeedSource[];
  media: Array<{ type: "image" | "video"; url: string; poster?: string; alt: string }>;
  publishedAt: string | null; createdAt: string; liked: boolean; hidden: boolean;
};
export type FeedPreferences = { instructions: string; revision: number; enabled: boolean; intervalMinutes: number; updatedAt: string | null };
export type FeedJob = { id: string; status: "queued" | "searching" | "writing" | "done" | "error"; createdAt: string; updatedAt: string; added: number; error: string | null; revision: number };
export type FeedMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
export type FeedPayload = { posts: FeedPost[]; nextCursor: string | null; preferences: FeedPreferences; job: FeedJob | null; capabilities: { generate: boolean; search: "brave" | "news-rss"; avatar: { image: string; video: string | null } } };
