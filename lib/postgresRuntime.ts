import fs from "node:fs";
import path from "node:path";
import { decryptSecret } from "./secretStorage";
import { PostgresDatabase, type PostgresConnection } from "./postgresDatabase";

export interface PostgresRuntimeConfig {
  version: 1; backend: "postgres"; host: string; port: number; database: string; user: string;
  schema: string; encryptedPassword: string; migrationId: string;
}
export const postgresRuntimeFile = () => path.join(process.cwd(), "data", "database-runtime.json");
const globalRuntime = globalThis as typeof globalThis & { __alcorPostgresRuntime?: Map<string, { config: PostgresRuntimeConfig; database: PostgresDatabase }> };
const connections = globalRuntime.__alcorPostgresRuntime ??= new Map();
export function readPostgresRuntime(): PostgresRuntimeConfig | null {
  const file = postgresRuntimeFile();
  if (!fs.existsSync(file)) {
    if (connections.has(file) || fs.existsSync(path.join(path.dirname(file), "database-postgres-required"))) throw Error("PostgreSQL 运行配置缺失或切换尚未完成；未回退 SQLite");
    return null;
  }
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as PostgresRuntimeConfig;
  if (config.version !== 1 || config.backend !== "postgres" || !config.host || !config.database || !config.user ||
    !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-z_][a-z0-9_]*$/.test(config.schema) ||
    !config.encryptedPassword?.startsWith("enc:v1:") || !config.migrationId) throw Error("数据库运行配置无效；未回退 SQLite");
  return config;
}
export function postgresConnection(config: PostgresRuntimeConfig): PostgresConnection {
  return { host: config.host, port: config.port, database: config.database, user: config.user, schema: config.schema, password: decryptSecret(config.encryptedPassword, true), ssl: false };
}
export function runtimePostgresDatabase(): PostgresDatabase | null {
  const file = postgresRuntimeFile(), existing = connections.get(file);
  // A live connection never switches backend as a side effect of saving ordinary settings.
  if (existing?.database.open) return existing.database;
  if (existing?.database.inTransaction) throw Error("原数据库事务连接已中断，请查询原操作回执");
  if (existing) existing.database.close();
  const config = readPostgresRuntime(); if (!config) return null;
  const database = new PostgresDatabase(postgresConnection(config));
  try {
    const state = database.raw("SELECT version,migration_id,active FROM _database_backend WHERE id=1").rows[0];
    if (state?.version !== 1 || state.migration_id !== config.migrationId || state.active !== true) throw Error("PostgreSQL 业务迁移尚未完成");
    connections.set(file, { config, database }); return database;
  } catch (error) { try { database.close(); } catch { /* Preserve the original connection error. */ } throw error; }
}
