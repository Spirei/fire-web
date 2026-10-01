import type { FeedPerson, FeedPost } from "./feedTypes";

export const FEED_PEOPLE: FeedPerson[] = [
  { id:"trump", name:"特朗普", handle:"@realDonaldTrump", platform:"Truth Social", avatar:"/uploads/celebs/trump.jpg" },
  { id:"duan", name:"段永平", handle:"@slowisquick", platform:"雪球", avatar:"/uploads/celebs/duan.jpg" }
];
export const feedPostTime = (post:FeedPost) => post.original ? post.publishedAt || post.createdAt : post.createdAt;
