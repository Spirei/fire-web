import type Database from 'better-sqlite3';
const installed = new WeakSet<Database.Database>();
export function installPriceAlerts(db: Database.Database) {
  if (installed.has(db)) return;
  db.transaction(()=>{
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_alert_collections (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS price_alert_rules (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL, grant_id TEXT NOT NULL, revision INTEGER NOT NULL,
      config TEXT NOT NULL, state TEXT NOT NULL, activated_at INTEGER NOT NULL,
      last_quote_at INTEGER NOT NULL DEFAULT 0, last_scan_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,id)
    );
    CREATE INDEX IF NOT EXISTS price_alert_active ON price_alert_rules(state);
    CREATE TABLE IF NOT EXISTS price_alert_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0, app INTEGER NOT NULL DEFAULT 1,
      email INTEGER NOT NULL DEFAULT 0, telegram INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS price_alert_operations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS price_alert_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL, rule_revision INTEGER NOT NULL, period TEXT NOT NULL,
      data TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
      UNIQUE(user_id,rule_id,rule_revision,period)
    );
    CREATE INDEX IF NOT EXISTS price_alert_inbox ON price_alert_events(user_id,created_at);
    CREATE TABLE IF NOT EXISTS price_alert_deliveries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES price_alert_events(id) ON DELETE CASCADE,
      channel TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(event_id,channel)
    );
    CREATE TABLE IF NOT EXISTS price_alert_telegram (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_secret TEXT NOT NULL, label TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
      challenge_hash TEXT, challenge_expires INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS price_alert_worker_state (id TEXT PRIMARY KEY,value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS price_alert_worker_lease (
      id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_at INTEGER NOT NULL
    );
  `);
  const columns=db.prepare('PRAGMA table_info(price_alert_preferences)').all() as {name:string}[];
  if(!columns.some(column=>column.name==='wechat'))db.exec('ALTER TABLE price_alert_preferences ADD COLUMN wechat INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS price_alert_wecom (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    recipient_secret TEXT NOT NULL DEFAULT '',confirmed INTEGER NOT NULL DEFAULT 0,config_stamp TEXT NOT NULL DEFAULT '',
    pending_recipient_secret TEXT NOT NULL DEFAULT '',pending_config_stamp TEXT NOT NULL DEFAULT '',challenge_id TEXT NOT NULL DEFAULT '',
    code_secret TEXT NOT NULL DEFAULT '',code_hash TEXT NOT NULL DEFAULT '',challenge_expires INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
    verification_state TEXT NOT NULL DEFAULT '',grant_id TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT 0
  )`);
  }).immediate();
  installed.add(db);
}
