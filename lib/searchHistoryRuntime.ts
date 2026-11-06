import { Pool } from "pg";
import { readPostgresRuntime, postgresConnection } from "./postgresRuntime";
import { createSearchHistoryStore } from "./searchHistoryStore";

type Runtime = { fingerprint: string; pool: Pool; store: ReturnType<typeof createSearchHistoryStore> };
const state = globalThis as typeof globalThis & { __alcorSearchHistory?: Runtime };
export class SearchHistoryUnavailable extends Error {}
export async function searchHistoryRuntime() {
  const config = readPostgresRuntime();
  if (!config) throw new SearchHistoryUnavailable("搜索历史尚未接入 PostgreSQL");
  const fingerprint = JSON.stringify(config);
  if (state.__alcorSearchHistory?.fingerprint !== fingerprint) {
    const previous = state.__alcorSearchHistory;
    const pool = new Pool({ ...postgresConnection(config), max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      application_name: "alcor-search-history", options: `-c search_path=${config.schema},pg_catalog -c statement_timeout=8000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000` });
    pool.on("error", () => {});
    state.__alcorSearchHistory = { fingerprint, pool, store: createSearchHistoryStore(pool) };
    if (previous) void previous.pool.end().catch(() => {});
  }
  const runtime = state.__alcorSearchHistory!;
  const marker = await runtime.pool.query("SELECT version,migration_id,active FROM _database_backend WHERE id=1");
  if (marker.rows[0]?.version !== 1 || marker.rows[0]?.migration_id !== config.migrationId || marker.rows[0]?.active !== true)
    throw new SearchHistoryUnavailable("PostgreSQL 尚未就绪");
  return runtime.store;
}
