import type Database from "better-sqlite3";
export function installAccountChanges(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_change_versions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER IF NOT EXISTS account_change_identity_version
    AFTER UPDATE OF email,password_hash ON users
    WHEN NEW.email IS NOT OLD.email OR NEW.password_hash IS NOT OLD.password_hash
    BEGIN
      INSERT INTO account_change_versions(user_id,version) VALUES(NEW.id,1)
      ON CONFLICT(user_id) DO UPDATE SET version=version+1;
    END;
    CREATE TABLE IF NOT EXISTS app_account_changes (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grant_id TEXT NOT NULL REFERENCES app_grants(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      stage TEXT NOT NULL,
      identity_version INTEGER NOT NULL,
      security_stamp TEXT NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_changes_user ON app_account_changes(user_id,purpose);
  `);
}
