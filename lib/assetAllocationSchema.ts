import type Database from "better-sqlite3";
export function installAssetAllocation(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS asset_allocation_accounts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL,
    amount REAL NOT NULL, category TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, source_id)
  );
  CREATE TABLE IF NOT EXISTS asset_allocation_revisions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(user_id,source_id)
  );
  INSERT OR IGNORE INTO asset_allocation_revisions SELECT user_id,source_id,revision FROM asset_allocation_accounts;
  CREATE TRIGGER IF NOT EXISTS allocation_insert_revision AFTER INSERT ON asset_allocation_accounts BEGIN
    INSERT INTO asset_allocation_revisions VALUES(NEW.user_id,NEW.source_id,NEW.revision)
    ON CONFLICT(user_id,source_id) DO UPDATE SET revision=revision+1;
    UPDATE asset_allocation_accounts SET revision=(SELECT revision FROM asset_allocation_revisions WHERE user_id=NEW.user_id AND source_id=NEW.source_id) WHERE user_id=NEW.user_id AND source_id=NEW.source_id;
  END;
  CREATE TRIGGER IF NOT EXISTS allocation_update_revision AFTER UPDATE OF name,currency,amount,category,excluded,updated_at ON asset_allocation_accounts BEGIN
    UPDATE asset_allocation_revisions SET revision=revision+1 WHERE user_id=NEW.user_id AND source_id=NEW.source_id;
    UPDATE asset_allocation_accounts SET revision=(SELECT revision FROM asset_allocation_revisions WHERE user_id=NEW.user_id AND source_id=NEW.source_id) WHERE user_id=NEW.user_id AND source_id=NEW.source_id;
  END;
  CREATE TRIGGER IF NOT EXISTS allocation_delete_revision AFTER DELETE ON asset_allocation_accounts BEGIN
    UPDATE asset_allocation_revisions SET revision=revision+1 WHERE user_id=OLD.user_id AND source_id=OLD.source_id;
  END;`);
}
