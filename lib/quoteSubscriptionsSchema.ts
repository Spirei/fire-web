import type Database from "better-sqlite3";

export function installQuoteSubscriptions(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS quote_subscriptions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      market TEXT NOT NULL CHECK (market IN ('US','HK','CN','JP','KR','ASSET')),
      code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
      last_requested_at INTEGER NOT NULL,
      reads INTEGER NOT NULL CHECK (reads BETWEEN 1 AND 2),
      PRIMARY KEY (user_id, market, code)
    );
    CREATE INDEX IF NOT EXISTS idx_quote_subscriptions_expiry ON quote_subscriptions(last_requested_at);
    CREATE INDEX IF NOT EXISTS idx_quote_subscriptions_security ON quote_subscriptions(market, code, last_requested_at);
  `);
}
