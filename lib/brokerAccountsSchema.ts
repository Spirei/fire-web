import { installBrokerHoldingSource } from "./brokerHoldingSourceSchema";
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
  db.exec(`CREATE TABLE IF NOT EXISTS broker_connections (
    account_id TEXT PRIMARY KEY REFERENCES broker_accounts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,secret TEXT NOT NULL,reference TEXT,reference_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS broker_statement_previews (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
      digest TEXT NOT NULL,payload TEXT NOT NULL,account_revision INTEGER NOT NULL,record_revision INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS broker_statement_imports (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
      digest TEXT NOT NULL,to_date TEXT NOT NULL,external_account TEXT NOT NULL,cash_json TEXT NOT NULL,imported_at TEXT NOT NULL,
      PRIMARY KEY(user_id,account_id,digest));
    CREATE TABLE IF NOT EXISTS broker_statement_events (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,account_id,external_id));
  `);
  const columns = (db.prepare("PRAGMA table_info(records)").all() as {name:string}[]).map(c=>c.name);
  if (!columns.includes("broker_account_id")) db.exec("ALTER TABLE records ADD COLUMN broker_account_id TEXT NOT NULL DEFAULT ''");
  // Only migrate links already defined by the previous exact-name contract.
  db.exec(`UPDATE records SET broker_account_id=COALESCE((SELECT id FROM broker_accounts a WHERE a.user_id=records.user_id AND a.name=records.group_name),'')
    WHERE broker_account_id='' AND EXISTS(SELECT 1 FROM broker_accounts a WHERE a.user_id=records.user_id AND a.name=records.group_name);
    CREATE INDEX IF NOT EXISTS idx_records_broker_owner ON records(user_id,broker_account_id);
    CREATE TRIGGER IF NOT EXISTS records_broker_insert AFTER INSERT ON records
    WHEN NEW.broker_account_id='' BEGIN
      UPDATE records SET broker_account_id=COALESCE((SELECT id FROM broker_accounts WHERE user_id=NEW.user_id AND name=NEW.group_name),'') WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS records_broker_group AFTER UPDATE OF group_name ON records
    WHEN NEW.group_name!=OLD.group_name BEGIN
      UPDATE records SET broker_account_id=COALESCE((SELECT id FROM broker_accounts WHERE user_id=NEW.user_id AND name=NEW.group_name),'') WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS records_broker_owner_insert BEFORE INSERT ON records
    WHEN NEW.broker_account_id!='' AND NOT EXISTS(SELECT 1 FROM broker_accounts WHERE id=NEW.broker_account_id AND user_id=NEW.user_id)
    BEGIN SELECT RAISE(ABORT,'Invalid broker account owner'); END;
    CREATE TRIGGER IF NOT EXISTS records_broker_owner_update BEFORE UPDATE OF broker_account_id,user_id ON records
    WHEN NEW.broker_account_id!='' AND NOT EXISTS(SELECT 1 FROM broker_accounts WHERE id=NEW.broker_account_id AND user_id=NEW.user_id)
    BEGIN SELECT RAISE(ABORT,'Invalid broker account owner'); END;
  `);
  const accountColumns=(db.prepare('PRAGMA table_info(broker_accounts)').all() as {name:string}[]).map(c=>c.name);
  if(!accountColumns.includes('currencies_json'))db.exec('ALTER TABLE broker_accounts ADD COLUMN currencies_json TEXT');
  installBrokerHoldingSource(db);
}
