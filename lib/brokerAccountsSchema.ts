import type Database from "better-sqlite3";
export function installBrokerAccounts(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS broker_accounts (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,provider_id TEXT,currency TEXT NOT NULL,revision INTEGER NOT NULL,
    icon BLOB,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(user_id,name COLLATE NOCASE));
    CREATE TABLE IF NOT EXISTS broker_account_operations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,request_id TEXT NOT NULL,
      result_json TEXT NOT NULL,PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS broker_account_collections (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL);
  `);
}
