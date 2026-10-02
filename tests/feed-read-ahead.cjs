module.exports=async function checkReadAhead(snapshot) {
  const assert=require('node:assert/strict'),{FeedReadAhead}=require('../lib/feedReadAhead.ts');
  const requests=[],request=(url,method,body,signal)=>new Promise((resolve,reject)=>requests.push({url,signal,resolve,reject}));
  const cache=new FeedReadAhead(request),settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  let warm=cache.preload('people','duan');void cache.preload('people','duan');
  assert.equal(requests.length,1,'hover/focus/touch share one read');assert.equal(cache.peek('people','duan'),null);
  requests[0].resolve(snapshot);await warm;
  assert.equal(cache.peek('people','duan'),snapshot);assert.equal(cache.peek('news','duan'),null);assert.equal(cache.peek('people','trump'),null);
  const read=await cache.read('people','duan',10,new AbortController().signal);
  assert.equal(requests.length,1,'navigation consumes the prefetch without another request');
  read.posts.push(read.posts[0]);assert.equal(snapshot.posts.length,read.posts.length-1,'pagination does not mutate the seed');
  assert.equal(cache.peek('people','duan'),null,'quiet checks do not reuse a consumed response');
  warm=cache.preload('people','duan');const stale=requests.at(-1);cache.invalidate('people');stale.resolve(snapshot);await warm;assert.equal(cache.peek('people','duan'),null,'a late pre-write result cannot repopulate the cache');
  warm=cache.preload('people','trump');const pending=requests.at(-1),leaving=new AbortController();
  const cancelled=cache.read('people','trump',10,leaving.signal);leaving.abort();await assert.rejects(cancelled,/Aborted|abort/i);assert(pending.signal.aborted);pending.resolve(snapshot);await warm;
  for(let i=0;i<9;i++)void cache.preload('group-'+i);assert(requests.at(-9).signal.aborted,'read-ahead is bounded to eight destinations');
  cache.invalidate();assert(requests.slice(-9).every(entry=>entry.signal.aborted));
  for(const entry of requests.slice(-9))entry.resolve(snapshot);await settle();
  warm=cache.preload('people','duan');requests.at(-1).reject(new Error('401'));await warm;assert.equal(cache.peek('people','duan'),null);
  const savedNow=Date.now;let clock=savedNow();Date.now=()=>clock;
  try{warm=cache.preload('people','duan');requests.at(-1).resolve(snapshot);await warm;clock+=20_001;assert.equal(cache.peek('people','duan'),null);}finally{Date.now=savedNow;cache.invalidate();}
  console.log('PASS bounded read-ahead shares requests, isolates groups/authors, and rejects expired, cancelled or invalidated results');
};
