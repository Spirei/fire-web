import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const APP_SYNC_DOMAINS=["profile","portfolio","watch","brokers","alerts","resources","feed","settings","authorization"] as const;
const watched:Record<string,{domain:string;owner?:string;columns?:string[]}>= {
  users:{domain:"profile",owner:"id",columns:["username","nickname","email","avatar"]},
  personal_profiles:{domain:"profile"}, records:{domain:"portfolio"},trade_orders:{domain:"portfolio"},fund_transactions:{domain:"portfolio"},
  broker_cash_accounts:{domain:"portfolio"},broker_cash_entries:{domain:"portfolio"},watch_groups:{domain:"watch"},
  broker_accounts:{domain:"brokers"},broker_connections:{domain:"brokers",columns:["revision"]},
  price_alert_rules:{domain:"alerts"},price_alert_preferences:{domain:"alerts"},price_alert_events:{domain:"alerts"},
  resource_files:{domain:"resources"},resource_folders:{domain:"resources"},
  feed_groups:{domain:"feed"},feed_group_preferences:{domain:"feed"},feed_posts:{domain:"feed"},feed_agent_profiles:{domain:"feed"},
  user_settings:{domain:"settings"},app_account_consents:{domain:"authorization"}
};
const installed=new WeakMap<Database.Database,Set<string>>();
const schemaVersions=new WeakMap<Database.Database,number>();
const opened=new WeakSet<Database.Database>();
export function bumpAppSync(db:Database.Database,userId:string,domain:string) {
  db.prepare("INSERT INTO app_sync_revisions(user_id,domain,revision) VALUES(?,?,1) ON CONFLICT(user_id,domain) DO UPDATE SET revision=revision+1").run(userId,domain);
}
/** SQL triggers participate in the original transaction, including rollback and deletion. */
export function installAppSync(db:Database.Database) {
  const schema=db.pragma("schema_version",{simple:true}) as number;
  if(schemaVersions.get(db)===schema)return;
  db.exec(`CREATE TABLE IF NOT EXISTS app_sync_metadata(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_sync_revisions(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,domain TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(user_id,domain));
    CREATE TABLE IF NOT EXISTS app_state_fields(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,namespace TEXT NOT NULL,field TEXT NOT NULL,value TEXT,revision INTEGER NOT NULL,PRIMARY KEY(user_id,namespace,field));
    CREATE TABLE IF NOT EXISTS app_state_operations(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,request_id));`);
  if(!opened.has(db)){
    // Reopening after a server/database restore must invalidate client baselines, even if counters moved backwards.
    db.prepare("INSERT INTO app_sync_metadata VALUES(1,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch").run(randomUUID());
    opened.add(db);
  }
  const done=installed.get(db)??new Set<string>();installed.set(db,done);
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
  for (const [table,definition] of Object.entries(watched)) {
    if(done.has(table)||!tables.has(table))continue;
    const columns=(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name), owner=definition.owner??"user_id";
    if(!columns.includes(owner))continue;
    const changed=(definition.columns??columns).filter(column=>columns.includes(column)).map(column=>`OLD.${column} IS NOT NEW.${column}`).join(" OR ");
    for (const operation of ["INSERT","UPDATE","DELETE"]) {
      const row=operation==="DELETE"?"OLD":"NEW",condition=operation==="UPDATE"?` WHEN ${changed}`:"";
      // No FK on the trigger's owner lookup: deletion of a whole user must remain valid.
      db.exec(`CREATE TRIGGER IF NOT EXISTS app_sync_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}${condition} BEGIN
        INSERT INTO app_sync_revisions(user_id,domain,revision) SELECT ${row}.${owner},'${definition.domain}',1 WHERE EXISTS(SELECT 1 FROM users WHERE id=${row}.${owner})
        ON CONFLICT(user_id,domain) DO UPDATE SET revision=revision+1; END;`);
    }
    done.add(table);
  }
  schemaVersions.set(db,db.pragma("schema_version",{simple:true}) as number);
}
