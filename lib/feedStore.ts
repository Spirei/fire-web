import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { FEED_ICONS, type FeedJob, type FeedMessage, type FeedPost, type FeedPreferences, type FeedSegment, type FeedSource } from "./feedTypes";
import { isPrivateHost } from "./net";

export class FeedError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const feedId = () => "fp-" + randomBytes(12).toString("hex");
const initialized = new WeakSet<object>();
export function feedTables() {
  const db = getDb();
  if (initialized.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, instructions TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, interval_minutes INTEGER NOT NULL DEFAULT 360, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS feed_posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, liked INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,fingerprint));
    CREATE INDEX IF NOT EXISTS feed_posts_owner ON feed_posts(user_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS feed_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, instructions TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS feed_jobs_owner ON feed_jobs(user_id,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS feed_jobs_running ON feed_jobs(user_id) WHERE status IN ('queued','searching','writing');
    CREATE TABLE IF NOT EXISTS feed_messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS feed_messages_owner ON feed_messages(user_id,post_id,created_at);
  `);
  initialized.add(db);
  return db;
}
export function feedPreferences(userId: string): FeedPreferences {
  const row = feedTables().prepare("SELECT * FROM feed_preferences WHERE user_id=?").get(userId) as { instructions:string;revision:number;enabled:number;interval_minutes:number;updated_at:string|null } | undefined;
  return row ? { instructions:row.instructions,revision:row.revision,enabled:!!row.enabled,intervalMinutes:row.interval_minutes,updatedAt:row.updated_at } : {instructions:"",revision:0,enabled:false,intervalMinutes:360,updatedAt:null};
}
export function saveFeedPreferences(userId: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FeedError("指示格式无效");
  const b = body as Record<string,unknown>;
  if (Object.keys(b).some(k=>!["instructions","revision","enabled","intervalMinutes"].includes(k)) || typeof b.instructions !== "string" || b.instructions.trim().length > 4000 || !Number.isInteger(b.revision) || (b.enabled !== undefined && typeof b.enabled !== "boolean") || (b.intervalMinutes !== undefined && (!Number.isInteger(b.intervalMinutes) || Number(b.intervalMinutes)<60 || Number(b.intervalMinutes)>1440))) throw new FeedError("指示最长 4000 字，更新间隔为 60–1440 分钟");
  const db = feedTables();
  return db.transaction(()=>{
    const prev = feedPreferences(userId);
    if (prev.revision !== b.revision) throw new FeedError("指示已在另一端修改，请重新打开后编辑",409);
    const instructions = String(b.instructions).trim();
    db.prepare("INSERT INTO feed_preferences (user_id,instructions,revision,enabled,interval_minutes,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET instructions=excluded.instructions,revision=excluded.revision,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,updated_at=excluded.updated_at")
      .run(userId,instructions,prev.revision+1,instructions && (b.enabled ?? true) ? 1 : 0,b.intervalMinutes ?? prev.intervalMinutes,new Date().toISOString());
    db.prepare("UPDATE feed_jobs SET status='error',error='指示已更新，请按新指示刷新',updated_at=? WHERE user_id=? AND status IN ('queued','searching','writing')").run(new Date().toISOString(),userId);
    return feedPreferences(userId);
  }).immediate();
}
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || isPrivateHost(u.hostname) || !u.hostname.includes(".") || /^(?:\[|0\.|224\.|255\.)/.test(u.hostname)) return null;
    u.hash=""; ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid"].forEach(k=>u.searchParams.delete(k));
    return u.toString();
  } catch { return null; }
}
type PostRow = { id:string;payload:string;created_at:string;liked:number;hidden:number };
function postFromRow(r: PostRow): FeedPost { return {...JSON.parse(r.payload),id:r.id,createdAt:r.created_at,liked:!!r.liked,hidden:!!r.hidden}; }
export function getFeedPost(userId:string,id:string): FeedPost {
  const row=feedTables().prepare("SELECT * FROM feed_posts WHERE user_id=? AND id=?").get(userId,id) as PostRow|undefined;
  if (!row) throw new FeedError("动态不存在",404);
  return postFromRow(row);
}
export function listFeedPosts(userId:string,cursor?:string|null,limit=20) {
  let time="",id="";
  if (cursor) {
    if (cursor.length>256) throw new FeedError("分页游标无效");
    try { const value=JSON.parse(Buffer.from(cursor,"base64url").toString()); time=value[0];id=value[1]; }
    catch { throw new FeedError("分页游标无效"); }
    if (typeof time!=="string" || !Number.isFinite(Date.parse(time)) || typeof id!=="string" || !/^fp-[a-f0-9]{24}$/.test(id)) throw new FeedError("分页游标无效");
  }
  const db=feedTables();
  const rows=(cursor ? db.prepare("SELECT * FROM feed_posts WHERE user_id=? AND hidden=0 AND (created_at < ? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(userId,time,time,id,limit+1) : db.prepare("SELECT * FROM feed_posts WHERE user_id=? AND hidden=0 ORDER BY created_at DESC,id DESC LIMIT ?").all(userId,limit+1)) as PostRow[];
  const posts=rows.slice(0,limit).map(postFromRow), last=posts.at(-1);
  return {posts,nextCursor:rows.length>limit && last ? Buffer.from(JSON.stringify([last.createdAt,last.id])).toString("base64url") : null};
}
export function updateFeedPost(userId:string,id:string,body:unknown) {
  getFeedPost(userId,id);
  if (!body || typeof body!=="object" || Array.isArray(body)) throw new FeedError("操作格式无效");
  const b=body as Record<string,unknown>,keys=Object.keys(b);
  if (!keys.length || keys.some(k=>!["liked","hidden"].includes(k) || typeof b[k]!=="boolean")) throw new FeedError("只允许修改喜欢和隐藏状态");
  const db=feedTables();
  db.prepare(`UPDATE feed_posts SET ${keys.map(k=>`${k}=?`).join(",")} WHERE id=? AND user_id=?`).run(...keys.map(k=>b[k]?1:0),id,userId);
  return getFeedPost(userId,id);
}
export function normalizeGeneratedPosts(value: unknown, sources: FeedSource[]) {
  if (!Array.isArray(value)) throw new FeedError("模型没有返回有效动态",502);
  const sourceMap=new Map(sources.map(s=>[s.id,s]));
  return value.slice(0,8).flatMap((v): Array<Omit<FeedPost,"id"|"createdAt"|"liked"|"hidden">>=>{
    if (!v || typeof v!=="object" || typeof v.title!=="string" || !v.title.trim() || !Array.isArray(v.segments)) return [];
    const segments:FeedSegment[]=v.segments.slice(0,16).flatMap((s:unknown)=>{
      if (!s || typeof s!=="object") return [];
      const r=s as Record<string,unknown>;
      if (typeof r.text!=="string" || !r.text.trim()) return [];
      return [{text:r.text.slice(0,700),...(typeof r.sourceId==="string" && sourceMap.has(r.sourceId)?{sourceId:r.sourceId}:{})}];
    });
    const used=[...new Set(segments.map(s=>s.sourceId).filter(Boolean))].map(id=>sourceMap.get(id!)!).filter(Boolean);
    // No invented URLs, dates, HTML, media or unsourced posts can enter the store.
    if (!used.length || !segments.length || segments.reduce((n,s)=>n+s.text.length,0)>2200) return [];
    const times=used.map(s=>s.publishedAt).filter((s):s is string=>!!s).sort();
    return [{title:v.title.trim().slice(0,140),icon:FEED_ICONS.includes(v.icon)?v.icon:"note",segments,sources:used,media:[],publishedAt:times.at(-1) ?? null}];
  });
}
export function appendFeedPosts(userId:string,posts:ReturnType<typeof normalizeGeneratedPosts>) {
  const db=feedTables();
  return db.transaction(()=>{
    let added=0;
    for (const post of posts) {
      const fingerprint=createHash("sha256").update(post.sources.map(s=>s.url).sort().join("\n")).digest("hex");
      added+=db.prepare("INSERT OR IGNORE INTO feed_posts(id,user_id,fingerprint,payload,created_at) VALUES(?,?,?,?,?)").run(feedId(),userId,fingerprint,JSON.stringify(post),new Date().toISOString()).changes;
    }
    return added;
  }).immediate();
}
type JobRow = {id:string;status:FeedJob["status"];created_at:string;updated_at:string;added:number;error:string|null;revision:number};
export function getFeedJob(userId:string,id?:string):FeedJob|null {
  const db=feedTables();
  db.prepare("UPDATE feed_jobs SET status='error',error='服务中断，请重试',updated_at=? WHERE user_id=? AND status IN ('queued','searching','writing') AND updated_at<?").run(new Date().toISOString(),userId,new Date(Date.now()-5*60_000).toISOString());
  const r=(id ? db.prepare("SELECT * FROM feed_jobs WHERE user_id=? AND id=?").get(userId,id) : db.prepare("SELECT * FROM feed_jobs WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(userId)) as JobRow|undefined;
  return r?{id:r.id,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,added:r.added,error:r.error,revision:r.revision}:null;
}
export function createFeedJob(userId:string) {
  const db=feedTables();
  return db.transaction(()=>{
    const running=getFeedJob(userId);
    if (running && ["queued","searching","writing"].includes(running.status)) return {job:running,created:false};
    const pref=feedPreferences(userId);
    if (!pref.instructions) throw new FeedError("先告诉 Alcor 你想关注什么");
    const active=db.prepare("SELECT COUNT(*) AS n FROM feed_jobs WHERE status IN ('queued','searching','writing') AND updated_at>=?").get(new Date(Date.now()-5*60_000).toISOString()) as {n:number};
    if (active.n>=8) throw new FeedError("动态任务较多，请稍后重试",429);
    const id="fj-"+randomBytes(12).toString("hex"),now=new Date().toISOString();
    db.prepare("INSERT INTO feed_jobs(id,user_id,status,instructions,revision,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?)").run(id,userId,pref.instructions,pref.revision,now,now);
    return {job:getFeedJob(userId,id)!,created:true};
  }).immediate();
}
export function feedMessages(userId:string,postId:string): FeedMessage[] {
  getFeedPost(userId,postId);
  return (feedTables().prepare("SELECT id,role,text,created_at AS createdAt FROM (SELECT * FROM feed_messages WHERE user_id=? AND post_id=? ORDER BY created_at DESC,id DESC LIMIT 40) ORDER BY created_at,id").all(userId,postId) as FeedMessage[]);
}
export function appendFeedMessages(userId:string,postId:string,question:string,answer:string) {
  const db=feedTables();
  db.transaction(()=>{
    getFeedPost(userId,postId);
    const insert=db.prepare("INSERT INTO feed_messages(id,user_id,post_id,role,text,created_at) VALUES(?,?,?,?,?,?)");
    const now=Date.now();
    insert.run("fm-"+randomBytes(12).toString("hex"),userId,postId,"user",question,new Date(now).toISOString());
    insert.run("fm-"+randomBytes(12).toString("hex"),userId,postId,"assistant",answer,new Date(now+1).toISOString());
  }).immediate();
  return feedMessages(userId,postId);
}
