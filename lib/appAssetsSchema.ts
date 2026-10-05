import type Database from "better-sqlite3";

/** Declared security identity is separate from legacy untyped position units. */
export function installAppAssets(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_asset_instruments (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      market TEXT NOT NULL, code TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('cash_equity','etf','unknown')),
      listing_status TEXT NOT NULL CHECK(listing_status IN ('listed','delisted','unknown')),
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,record_id)
    );
    CREATE TABLE IF NOT EXISTS app_asset_operations (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(user_id,request_id)
    );
    CREATE TRIGGER IF NOT EXISTS app_asset_identity_update
      AFTER UPDATE OF market,code ON records
      WHEN OLD.market IS NOT NEW.market OR OLD.code IS NOT NEW.code BEGIN
      UPDATE app_asset_instruments SET market='',code='',kind='unknown',listing_status='unknown',
        revision=revision+1,updated_at=NEW.updated_at
      WHERE user_id=NEW.user_id AND record_id=NEW.id;
    END;
  `);
}
