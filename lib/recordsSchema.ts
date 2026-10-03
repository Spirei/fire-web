import type Database from "better-sqlite3";

/** Track every writer, including orders/imports and legacy Web requests. */
export function installRecordsContract(db: Database.Database) {
  db.transaction(() => {
    const columns = db.prepare("PRAGMA table_info(records)").all() as { name: string }[];
    if (!columns.some(c => c.name === "revision")) db.exec("ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    db.exec(`
      CREATE TABLE IF NOT EXISTS record_revisions (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY(user_id, record_id)
      );
      CREATE TABLE IF NOT EXISTS record_collections (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS record_operations (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY(user_id, request_id)
      );
      INSERT OR IGNORE INTO record_revisions(user_id,record_id,revision) SELECT user_id,id,revision FROM records;
      CREATE TRIGGER IF NOT EXISTS records_contract_insert AFTER INSERT ON records BEGIN
        INSERT INTO record_revisions(user_id,record_id,revision) VALUES(NEW.user_id,NEW.id,1)
          ON CONFLICT(user_id,record_id) DO UPDATE SET revision=record_revisions.revision+1;
        UPDATE records SET revision=(SELECT revision FROM record_revisions WHERE user_id=NEW.user_id AND record_id=NEW.id) WHERE id=NEW.id;
        INSERT INTO record_collections(user_id,revision) VALUES(NEW.user_id,1)
          ON CONFLICT(user_id) DO UPDATE SET revision=record_collections.revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS records_contract_update AFTER UPDATE OF
        name,code,market,price,cost,qty,group_name,watch_group_id,watch_group_sort,note,source,updated_at ON records BEGIN
        INSERT INTO record_revisions(user_id,record_id,revision) VALUES(NEW.user_id,NEW.id,OLD.revision+1)
          ON CONFLICT(user_id,record_id) DO UPDATE SET revision=record_revisions.revision+1;
        UPDATE records SET revision=(SELECT revision FROM record_revisions WHERE user_id=NEW.user_id AND record_id=NEW.id) WHERE id=NEW.id;
        INSERT INTO record_collections(user_id,revision) VALUES(NEW.user_id,1)
          ON CONFLICT(user_id) DO UPDATE SET revision=record_collections.revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS records_contract_delete AFTER DELETE ON records
        WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN
        INSERT INTO record_revisions(user_id,record_id,revision) VALUES(OLD.user_id,OLD.id,OLD.revision+1)
          ON CONFLICT(user_id,record_id) DO UPDATE SET revision=record_revisions.revision+1;
        INSERT INTO record_collections(user_id,revision) VALUES(OLD.user_id,1)
          ON CONFLICT(user_id) DO UPDATE SET revision=record_collections.revision+1;
      END;
    `);
  }).immediate();
}
