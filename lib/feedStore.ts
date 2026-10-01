import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { FEED_PAGE_SIZE, FEED_ICONS, type FeedJob, type FeedMessage, type FeedPost, type FeedPreferences, type FeedSegment, type FeedSource, type FeedGroup, type FeedMode, type FeedPersonId } from "./feedTypes";
import { FEED_PEOPLE } from "./feedPeopleConfig";
import { FeedError, sourceUrl } from "./feedValidation";
export { FeedError, sourceUrl } from "./feedValidation";
import { restrainedFeedSegments } from "./feedPresentation";
import { normalizeFeedSubscriptions } from "./feedSubscriptions";

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
  // Additive migration: old rows remain in the default group, never rewrite payload/history.
  db.transaction(()=>{
    for(const table of ["feed_posts","feed_jobs"]){if(!(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(c=>c.name==="group_id"))db.exec(`ALTER TABLE ${table} ADD COLUMN group_id TEXT NOT NULL DEFAULT 'default'`);}
    db.exec(`CREATE TABLE IF NOT EXISTS feed_groups (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,subscriptions TEXT NOT NULL DEFAULT '[]',updated_at TEXT,PRIMARY KEY(user_id,id));
      CREATE TABLE IF NOT EXISTS feed_group_preferences (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,group_id TEXT NOT NULL,instructions TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,interval_minutes INTEGER NOT NULL DEFAULT 360,updated_at TEXT,PRIMARY KEY(user_id,group_id));
      CREATE INDEX IF NOT EXISTS feed_posts_group ON feed_posts(user_id,group_id,created_at DESC,id DESC);`);
    for(const [table,column,definition] of [
      ["feed_groups","mode","TEXT NOT NULL DEFAULT 'news'"],
      ["feed_groups","people","TEXT NOT NULL DEFAULT '[\"trump\",\"duan\"]'"],
      ["feed_posts","kind","TEXT NOT NULL DEFAULT 'news'"],
      ["feed_posts","sort_at","TEXT NOT NULL DEFAULT ''"],
      ["feed_posts","author_key","TEXT NOT NULL DEFAULT ''"]
    ])if(!(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    db.exec("UPDATE feed_posts SET sort_at=created_at WHERE sort_at=''; CREATE INDEX IF NOT EXISTS feed_posts_timeline ON feed_posts(user_id,group_id,kind,sort_at DESC,id DESC)");
  }).immediate();
  initialized.add(db);
  return db;
}
export function feedGroup(userId:string,id="default"):FeedGroup {
  if(id!=="default"&&!/^fg-[a-f0-9]{24}$/.test(id))throw new FeedError("动态组不存在",404);
  const row=feedTables().prepare("SELECT name,subscriptions,updated_at,mode,people FROM feed_groups WHERE user_id=? AND id=?").get(userId,id) as {name:string;subscriptions:string;updated_at:string|null;mode:FeedMode;people:string}|undefined;
  if(!row&&id!=="default")throw new FeedError("动态组不存在",404);
  return {id,name:row?.name||"动态",subscriptions:row?JSON.parse(row.subscriptions):[],updatedAt:row?.updated_at||null,revision:feedPreferences(userId,id).revision,mode:row?.mode||"news",people:row?JSON.parse(row.people):["trump","duan"]};
}
function normalizeFeedMode(value:unknown):FeedMode {
  if(value!=="news"&&value!=="people")throw new FeedError("请选择新闻提炼或人物原帖");return value;
}
function normalizeFeedPeople(value:unknown):FeedPersonId[] {
  if(!Array.isArray(value)||!value.length||value.length>FEED_PEOPLE.length||value.some(id=>!FEED_PEOPLE.some(person=>person.id===id))||new Set(value).size!==value.length)throw new FeedError("请选择有效且不重复的人物");return value as FeedPersonId[];
}
export function listFeedGroups(userId:string) {
  return [feedGroup(userId),...(feedTables().prepare("SELECT id FROM feed_groups WHERE user_id=? AND id<>'default' ORDER BY updated_at,id").all(userId) as {id:string}[]).map(r=>feedGroup(userId,r.id))];
}
export function createFeedGroup(userId:string,body:unknown) {
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!["name","mode","people"].includes(k))||typeof (body as {name?:unknown}).name!=="string")throw new FeedError("请填写动态组名称");
  const name=(body as {name:string}).name.trim();if(!name||name.length>40)throw new FeedError("组名称为1–40字");
  const b=body as Record<string,unknown>,mode=normalizeFeedMode(b.mode??"news"),people=normalizeFeedPeople(b.people??["trump","duan"]);
  const db=feedTables();return db.transaction(()=>{if(listFeedGroups(userId).length>=12)throw new FeedError("每个账号最多12个动态组");const id="fg-"+randomBytes(12).toString("hex");db.prepare("INSERT INTO feed_groups(user_id,id,name,updated_at,mode,people) VALUES(?,?,?,?,?,?)").run(userId,id,name,new Date().toISOString(),mode,JSON.stringify(people));
    if(mode==="people")saveFeedPreferences(userId,{instructions:"",revision:0,mode,people,intervalMinutes:5},id);
    return feedGroup(userId,id);}).immediate();
}
export function feedPreferences(userId: string,groupId="default"): FeedPreferences {
  const db=feedTables();
  const row = (groupId==="default"?db.prepare("SELECT * FROM feed_preferences WHERE user_id=?").get(userId):db.prepare("SELECT * FROM feed_group_preferences WHERE user_id=? AND group_id=?").get(userId,groupId)) as { instructions:string;revision:number;enabled:number;interval_minutes:number;updated_at:string|null } | undefined;
  return row ? { instructions:row.instructions,revision:row.revision,enabled:!!row.enabled,intervalMinutes:row.interval_minutes,updatedAt:row.updated_at } : {instructions:"",revision:0,enabled:false,intervalMinutes:360,updatedAt:null};
}
export function saveFeedPreferences(userId: string, body: unknown,groupId="default") {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FeedError("指示格式无效");
  const b = body as Record<string,unknown>;
  const current=feedGroup(userId,groupId),mode=normalizeFeedMode(b.mode??current.mode??"news"),people=normalizeFeedPeople(b.people??current.people??["trump","duan"]);
  const minimum=mode==="people"?5:60;
  if (Object.keys(b).some(k=>!["instructions","revision","enabled","intervalMinutes","name","subscriptions","mode","people"].includes(k)) || typeof b.instructions !== "string" || b.instructions.trim().length > 4000 || !Number.isInteger(b.revision) || (b.enabled !== undefined && typeof b.enabled !== "boolean") || (b.intervalMinutes !== undefined && (!Number.isInteger(b.intervalMinutes) || Number(b.intervalMinutes)<minimum || Number(b.intervalMinutes)>1440))) throw new FeedError(`指示最长 4000 字，更新间隔为 ${minimum}–1440 分钟`);
  if(b.name!==undefined&&(typeof b.name!=="string"||!b.name.trim()||b.name.trim().length>40))throw new FeedError("组名称为1–40字");
  const subscriptions=b.subscriptions===undefined?undefined:normalizeFeedSubscriptions(b.subscriptions);
  const db = feedTables();
  return db.transaction(()=>{
    const group=feedGroup(userId,groupId),prev = feedPreferences(userId,groupId);
    if (prev.revision !== b.revision) throw new FeedError("指示已在另一端修改，请重新打开后编辑",409);
    const instructions = String(b.instructions).trim();
    const interval=b.intervalMinutes??(mode!==group.mode?(mode==="people"?5:360):prev.intervalMinutes);
    const now=new Date().toISOString(),values=[userId,instructions,prev.revision+1,(mode==="people"||instructions) && (b.enabled ?? true) ? 1 : 0,interval,now];
    if(groupId==="default")db.prepare("INSERT INTO feed_preferences (user_id,instructions,revision,enabled,interval_minutes,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET instructions=excluded.instructions,revision=excluded.revision,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,updated_at=excluded.updated_at").run(...values);
    else db.prepare("INSERT INTO feed_group_preferences (user_id,instructions,revision,enabled,interval_minutes,updated_at,group_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,group_id) DO UPDATE SET instructions=excluded.instructions,revision=excluded.revision,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,updated_at=excluded.updated_at").run(...values,groupId);
    db.prepare("INSERT INTO feed_groups(user_id,id,name,subscriptions,updated_at,mode,people) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,subscriptions=excluded.subscriptions,updated_at=excluded.updated_at,mode=excluded.mode,people=excluded.people").run(userId,groupId,b.name||group.name,JSON.stringify(subscriptions||group.subscriptions),now,mode,JSON.stringify(people));
    db.prepare("UPDATE feed_jobs SET status='error',error='指示已更新，请按新指示刷新',updated_at=? WHERE user_id=? AND group_id=? AND status IN ('queued','searching','writing')").run(now,userId,groupId);
    return feedPreferences(userId,groupId);
  }).immediate();
}
type PostRow = { id:string;payload:string;created_at:string;liked:number;hidden:number;sort_at:string };
function postFromRow(r: PostRow): FeedPost { return {...JSON.parse(r.payload),id:r.id,createdAt:r.created_at,liked:!!r.liked,hidden:!!r.hidden}; }
export function getFeedPost(userId:string,id:string): FeedPost {
  const row=feedTables().prepare("SELECT * FROM feed_posts WHERE user_id=? AND id=?").get(userId,id) as PostRow|undefined;
  if (!row) throw new FeedError("动态不存在",404);
  return postFromRow(row);
}
export function listFeedPosts(userId:string,cursor?:string|null,limit=FEED_PAGE_SIZE,groupId="default",author?:string|null) {
  const group=feedGroup(userId,groupId),mode=group.mode||"news";
  if(author&&(!group.people?.includes(author as FeedPersonId)||mode!=="people"))throw new FeedError("人物筛选无效");
  let time="",id="";
  if (cursor) {
    if (cursor.length>256) throw new FeedError("分页游标无效");
    try { const value=JSON.parse(Buffer.from(cursor,"base64url").toString()); time=value[0];id=value[1]; }
    catch { throw new FeedError("分页游标无效"); }
    if (typeof time!=="string" || !Number.isFinite(Date.parse(time)) || typeof id!=="string" || !/^fp-[a-f0-9]{24}$/.test(id)) throw new FeedError("分页游标无效");
  }
  const db=feedTables();
  const where="user_id=? AND group_id=? AND kind=? AND hidden=0"+(mode==="people"?` AND author_key IN (${(group.people||[]).map(()=>"?").join(",")})`:"")+(author?" AND author_key=?":"")+(cursor?" AND (sort_at < ? OR (sort_at=? AND id<?))":"");
  const values=[userId,groupId,mode,...(mode==="people"?group.people||[]:[]),...(author?[author]:[]),...(cursor?[time,time,id]:[]),limit+1];
  const rows=db.prepare(`SELECT * FROM feed_posts WHERE ${where} ORDER BY sort_at DESC,id DESC LIMIT ?`).all(...values) as PostRow[];
  const posts=rows.slice(0,limit).map(postFromRow),last=rows[Math.min(rows.length,limit)-1];
  return {posts,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([last.sort_at,last.id])).toString("base64url"):null};
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
    const segments:FeedSegment[]=restrainedFeedSegments(v.segments.slice(0,16).flatMap((s:unknown)=>{
      if (!s || typeof s!=="object") return [];
      const r=s as Record<string,unknown>;
      if (typeof r.text!=="string" || !r.text.trim()) return [];
      return [{text:r.text.slice(0,700),...(typeof r.sourceId==="string" && sourceMap.has(r.sourceId)?{sourceId:r.sourceId}:{ }),...(typeof r.linkText==="string"?{linkText:r.linkText}:{})}];
    }));
    const used=[...new Set(segments.map(s=>s.sourceId).filter(Boolean))].map(id=>sourceMap.get(id!)!).filter(Boolean);
    // No invented URLs, dates, HTML, media or unsourced posts can enter the store.
    if (!used.length || !segments.length || segments.reduce((n,s)=>n+s.text.length,0)>2200) return [];
    const times=used.map(s=>s.publishedAt).filter((s):s is string=>!!s).sort();
    const media=used.flatMap(s=>s.media||[]).filter(m=>sourceUrl(m.url)&&(!m.poster||sourceUrl(m.poster))).filter((m,i,all)=>all.findIndex(other=>other.url===m.url)===i).slice(0,3);
    return [{title:v.title.trim().slice(0,140),icon:FEED_ICONS.includes(v.icon)?v.icon:"note",segments,sources:used,media,publishedAt:times.at(-1) ?? null}];
  });
}
export function appendFeedPosts(userId:string,posts:ReturnType<typeof normalizeGeneratedPosts>,groupId="default") {
  feedGroup(userId,groupId);
  const db=feedTables();
  return db.transaction(()=>{
    let added=0;
    for (const post of posts) {
      const fingerprint=createHash("sha256").update((groupId==="default"?"":groupId+"\n")+post.sources.map(s=>s.url).sort().join("\n")).digest("hex");
      const now=new Date().toISOString();
      added+=db.prepare("INSERT OR IGNORE INTO feed_posts(id,user_id,fingerprint,payload,created_at,group_id,sort_at) VALUES(?,?,?,?,?,?,?)").run(feedId(),userId,fingerprint,JSON.stringify(post),now,groupId,now).changes;
    }
    return added;
  }).immediate();
}
type JobRow = {id:string;status:FeedJob["status"];created_at:string;updated_at:string;added:number;error:string|null;revision:number;group_id:string};
export function getFeedJob(userId:string,id?:string,groupId="default"):FeedJob|null {
  const db=feedTables();
  db.prepare("UPDATE feed_jobs SET status='error',error='服务中断，请重试',updated_at=? WHERE user_id=? AND status IN ('queued','searching','writing') AND updated_at<?").run(new Date().toISOString(),userId,new Date(Date.now()-5*60_000).toISOString());
  const r=(id ? db.prepare("SELECT * FROM feed_jobs WHERE user_id=? AND id=?").get(userId,id) : db.prepare("SELECT * FROM feed_jobs WHERE user_id=? AND group_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(userId,groupId)) as JobRow|undefined;
  return r?{id:r.id,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,added:r.added,error:r.error,revision:r.revision,groupId:r.group_id}:null;
}
export function createFeedJob(userId:string,groupId="default") {
  const db=feedTables();
  return db.transaction(()=>{
    feedGroup(userId,groupId);const running=getFeedJob(userId,undefined,groupId);
    if (running && ["queued","searching","writing"].includes(running.status)) return {job:running,created:false};
    if(db.prepare("SELECT id FROM feed_jobs WHERE user_id=? AND status IN ('queued','searching','writing')").get(userId))throw new FeedError("另一动态组正在更新，请稍后再试",429);
    const pref=feedPreferences(userId,groupId);
    if (!pref.instructions&&feedGroup(userId,groupId).mode!=="people") throw new FeedError("先告诉 Alcor 你想关注什么");
    const active=db.prepare("SELECT COUNT(*) AS n FROM feed_jobs WHERE status IN ('queued','searching','writing') AND updated_at>=?").get(new Date(Date.now()-5*60_000).toISOString()) as {n:number};
    if (active.n>=8) throw new FeedError("动态任务较多，请稍后重试",429);
    const id="fj-"+randomBytes(12).toString("hex"),now=new Date().toISOString();
    db.prepare("INSERT INTO feed_jobs(id,user_id,status,instructions,revision,created_at,updated_at,group_id) VALUES(?,?,'queued',?,?,?,?,?)").run(id,userId,pref.instructions,pref.revision,now,now,groupId);
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
