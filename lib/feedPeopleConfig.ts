import type { FeedPerson, FeedPost } from "./feedTypes";

export const FEED_PEOPLE: FeedPerson[] = [
  { id:"trump", name:"特朗普", handle:"@realDonaldTrump", platform:"Truth Social", avatar:"/uploads/celebs/trump-custom-1786043526485-1e34c87e.png" },
  { id:"duan", name:"段永平", handle:"@slowisquick", platform:"雪球", avatar:"/uploads/celebs/duan-custom-1785959747574-b3c57b2d.png" }
];
export const feedPostTime = (post:FeedPost) => post.original ? post.publishedAt || post.createdAt : post.createdAt;

export function feedPersonHasUpdates(id:string,latest:Record<string,string|null|undefined>|undefined,seen:Record<string,string|null|undefined>) {
  if(!FEED_PEOPLE.some(person=>person.id===id))return false;
  const before=Date.parse(seen[id]||""),after=Date.parse(latest?.[id]||"");
  return Number.isFinite(before)&&Number.isFinite(after)&&after>before;
}

/** Preserve newer reads from another tab and ignore malformed timestamps. */
export function mergeFeedSeen(previous:Record<string,string|null|undefined>,updates:Record<string,string|null|undefined>) {
  let next=previous;
  for(const person of FEED_PEOPLE) {
    const value=updates[person.id],time=Date.parse(value||""),before=Date.parse(previous[person.id]||"");
    if(!Number.isFinite(time)||(Number.isFinite(before)&&time<=before))continue;
    if(next===previous)next={...previous};
    next[person.id]=value;
  }
  return next;
}
