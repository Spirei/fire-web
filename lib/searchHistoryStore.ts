import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SEARCH_HISTORY_LIMIT, type SearchHistorySnapshot, type SearchHistoryMutation } from "./searchHistory";

// Native PostgreSQL only. No SQL translation, business initializer, Redis source of truth or SQLite fallback.
export function createSearchHistoryStore(pool: Pool) {
  let installed: Promise<unknown> | null = null;
  const install = () => installed ??= (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('alcor-search-history-schema'))");
      await client.query(`
    CREATE TABLE IF NOT EXISTS user_search_history_state (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    CREATE TABLE IF NOT EXISTS user_search_history (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query_key text NOT NULL,
      query text NOT NULL CHECK (char_length(query) BETWEEN 1 AND 80),
      searched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(user_id, query_key)
    );
    CREATE INDEX IF NOT EXISTS user_search_history_recent ON user_search_history(user_id, searched_at DESC, id DESC);
      `);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  })().catch(error => { installed = null; throw error; });
  async function snapshot(client: PoolClient, userId: string): Promise<SearchHistorySnapshot> {
    const state = await client.query("SELECT revision FROM user_search_history_state WHERE user_id=$1", [userId]);
    const rows = await client.query("SELECT id,query,searched_at FROM user_search_history WHERE user_id=$1 ORDER BY searched_at DESC,id DESC LIMIT $2", [userId, SEARCH_HISTORY_LIMIT]);
    return { revision: Number(state.rows[0].revision), items: rows.rows.map(row => ({ id: row.id, query: row.query, searchedAt: new Date(row.searched_at).toISOString() })) };
  }
  async function access(userId: string, mutation?: SearchHistoryMutation, authorize: () => void = () => {}) {
    await install();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO user_search_history_state(user_id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
      const state = await client.query("SELECT revision FROM user_search_history_state WHERE user_id=$1 FOR UPDATE", [userId]);
      authorize();
      const conflict = Boolean(mutation && Number(state.rows[0].revision) !== mutation.revision);
      if (mutation && !conflict) {
        if (mutation.action === "record") {
          await client.query(`INSERT INTO user_search_history(id,user_id,query_key,query) VALUES($1,$2,$3,$4)
            ON CONFLICT(user_id,query_key) DO UPDATE SET query=EXCLUDED.query,searched_at=clock_timestamp()`, [randomUUID(), userId, mutation.query.toLowerCase(), mutation.query]);
          await client.query(`DELETE FROM user_search_history WHERE user_id=$1 AND id IN (
            SELECT id FROM user_search_history WHERE user_id=$1 ORDER BY searched_at DESC,id DESC OFFSET $2)`, [userId, SEARCH_HISTORY_LIMIT]);
        } else if (mutation.action === "remove") {
          await client.query("DELETE FROM user_search_history WHERE user_id=$1 AND id=$2", [userId, mutation.id]);
        } else {
          await client.query("DELETE FROM user_search_history WHERE user_id=$1", [userId]);
        }
        await client.query("UPDATE user_search_history_state SET revision=revision+1 WHERE user_id=$1", [userId]);
      }
      const history = await snapshot(client, userId);
      authorize();
      await client.query("COMMIT");
      return { ...history, conflict };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return { access };
}
