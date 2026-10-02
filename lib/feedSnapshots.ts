import type { FeedChrome, FeedPayload } from "./feedTypes";

/** Reuse unchanged cards so quiet checks do not repaint text, images or videos. */
export function reconcileFeedPayload(previous:FeedPayload|null,next:FeedPayload):FeedPayload {
  if(!previous||previous.group?.id!==next.group?.id)return next;
  const known=new Map(previous.posts.map(post=>[post.id,post]));
  const posts=next.posts.map(post=>{
    const old=known.get(post.id);
    return old&&JSON.stringify(old)===JSON.stringify(post)?old:post;
  });
  const unchanged=posts.length===previous.posts.length&&posts.every((post,index)=>post===previous.posts[index]);
  const result={...next,posts:unchanged?previous.posts:posts};
  return unchanged&&JSON.stringify({...previous,posts:undefined})===JSON.stringify({...next,posts:undefined})?previous:result;
}

/** Only these fields affect the persistent header and a group's loading shell. */
export function feedChromeKey(payload:FeedChrome|null) {
  return payload?JSON.stringify([payload.agent,payload.groups,payload.peopleCatalog,payload.capabilities]):"";
}
