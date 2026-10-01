export const FEED_PAGE_SIZE = 10;

/** Shared JSON contract: Web and native clients never need to parse rendered HTML. */
export const FEED_ICONS = ["market", "chart", "world", "technology", "idea", "note", "security", "time", "conversation", "magic", "image", "palette", "check"] as const;
export type FeedIcon = typeof FEED_ICONS[number];
export type FeedMedia = { type: "image" | "video"; url: string; poster?: string; alt: string; playback?: "external" };
export type FeedSource = { id: string; title: string; url: string; publisher: string; publishedAt: string | null; excerpt: string; evidence?: "publisher-page"; media?: FeedMedia[] };
export type FeedSegment = { text: string; sourceId?: string; linkText?: string };
export type FeedSubscription = { name:string; url:string };
export type FeedMode = "news" | "people";
export type FeedPersonId = "trump" | "duan";
export type FeedPerson = { id:FeedPersonId; name:string; handle:string; platform:string; avatar:string };
export type FeedOriginal = { person:FeedPerson; platformPostId:string; text:string; textZh?:string; originalUrl:string; replyTo?:string; mediaUnavailable?:boolean; quote?:{name:string;text:string;url?:string;media:FeedMedia[]} };
export type FeedGroup = { id:string; name:string; revision:number; subscriptions:FeedSubscription[]; updatedAt:string|null; mode?:FeedMode; people?:FeedPersonId[] };
export type FeedPost = {
  id: string; title: string; icon: FeedIcon; segments: FeedSegment[]; sources: FeedSource[];
  media: FeedMedia[];
  publishedAt: string | null; createdAt: string; liked: boolean; hidden: boolean;
  original?: FeedOriginal;
};
export type FeedPreferences = { instructions: string; revision: number; enabled: boolean; intervalMinutes: number; updatedAt: string | null };
export type FeedJob = { id: string; status: "queued" | "searching" | "writing" | "done" | "error"; createdAt: string; updatedAt: string; added: number; error: string | null; revision: number; groupId?:string };
export type FeedMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
export type FeedPeopleSourceStatus = { personId:FeedPersonId; lastAttemptAt:string|null; lastSuccessAt:string|null; error:string|null };
export type FeedPayload = { posts: FeedPost[]; nextCursor: string | null; preferences: FeedPreferences; job: FeedJob | null; group?:FeedGroup; groups?:FeedGroup[]; recommendations?:FeedSubscription[]; observedPublishers?:string[]; peopleSources?:FeedPeopleSourceStatus[]; capabilities: { generate: boolean; search: "brave" | "news-rss"; searchProvider?: "deepseek" | "brave" | "news-rss"; avatar: { image: string; video: string | null } } };
