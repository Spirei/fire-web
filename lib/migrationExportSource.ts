import fs from "node:fs/promises";
import path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";
import { Client } from "pg";
import { CURRENT_VERSION } from "./versions";
import { MigrationExportError } from "./migrationExportFiles";

export type ExportSource = { origin: string; appVersion: string; buildSha: string; backend: "postgres"; database: string; schema: string; migrationId: string; instanceId: string; serverVersion: string; driver: "pg" };
export type ExportActor = { id: string; uid: string | null; sessionHash: string; expiresAt: string; authenticatedAt: string };
export type ExportContext = { root: string; client: Client; close: () => Promise<void>; actor: ExportActor; source: ExportSource; configurationStamp: string; connection: { host: string; port: number; database: string; user: string; password: string; ssl: false } };
const state = globalThis as typeof globalThis & { __alcorMigrationConnections?: { active: number } };
const connections = state.__alcorMigrationConnections ??= { active: 0 };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const denied = () => new MigrationExportError("admin_required", "需要重新登录的管理员会话", 403);
export const quoted = (name: string) => '"' + name.replace(/"/g, '""') + '"';

/** No getDb/auth/settings imports: those entry points migrate or schedule work. */
export async function readExportConfiguration(root: string) {
  const raw = await fs.readFile(path.join(root, "data/database-runtime.json"), "utf8").catch(() => { throw new MigrationExportError("postgres_required", "尚未核准 PostgreSQL 运行配置；不会导出本地 SQLite"); });
  let config;
  try { config = JSON.parse(raw); } catch { throw new MigrationExportError("runtime_invalid", "PostgreSQL 运行配置无效"); }
  if (config.version !== 1 || config.backend !== "postgres" || typeof config.host !== "string" || !config.host || typeof config.database !== "string" || !config.database || typeof config.user !== "string" || !config.user || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-z_][a-z0-9_]*$/.test(config.schema) || typeof config.migrationId !== "string" || !config.migrationId || typeof config.encryptedPassword !== "string" || !config.encryptedPassword.startsWith("enc:v1:")) throw new MigrationExportError("runtime_invalid", "PostgreSQL 运行配置无效");
  // Read only. Never generate, chmod, export or log the source encryption key.
  const environmentKey = process.env.FIRE_ENCRYPTION_KEY?.trim();
  const keyBytes = environmentKey ? Buffer.from(environmentKey) : await fs.readFile(path.join(root, "data/.fire-encryption-key")).catch(() => { throw new MigrationExportError("source_key_missing", "源加密密钥缺失；未生成替代密钥"); });
  if (!environmentKey && keyBytes.length < 32) throw new MigrationExportError("source_key_invalid", "源加密密钥无效");
  const key = createHash("sha256").update(keyBytes).digest();
  try {
    const fields = config.encryptedPassword.slice(7).split(":").map((part: string) => Buffer.from(part, "base64"));
    if (fields.length !== 3 || fields[0].length !== 12 || fields[1].length !== 16) throw Error();
    const decipher = createDecipheriv("aes-256-gcm", key, fields[0]); decipher.setAuthTag(fields[1]);
    const password = Buffer.concat([decipher.update(fields[2]), decipher.final()]).toString("utf8");
    return { config, keyFingerprint: digest(key), stamp: digest(raw + ":" + digest(key)), connection: { host: config.host as string, port: config.port as number, database: config.database as string, user: config.user as string, password, ssl: false as const } };
  } catch { throw new MigrationExportError("source_key_invalid", "源数据库凭据无法解密"); }
  finally { key.fill(0); keyBytes.fill(0); }
}

function cookieToken(request: Request) {
  const cookies = new Map((request.headers.get("cookie") || "").split(";").map(value => { const at = value.indexOf("="); return [value.slice(0, at).trim(), value.slice(at + 1).trim()]; }));
  const token = cookies.get("fire_session") || cookies.get("stocklog_session");
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function verifyLiveActor(client: Client, schema: string, sessionHash: string, recent = false): Promise<ExportActor> {
  const row = (await client.query(`SELECT u.id::text,u.uid::text,s.expires_at::text,s.authenticated_at::text FROM ${quoted(schema)}.sessions s JOIN ${quoted(schema)}.users u ON u.id=s.user_id WHERE s.token=$1 AND u.role='admin'`, [sessionHash])).rows[0];
  const now = BigInt(Date.now());
  if (!row || BigInt(row.expires_at) <= now || (recent && (BigInt(row.authenticated_at) > now || BigInt(row.authenticated_at) <= now - 900000n))) throw denied();
  return { id: row.id, uid: row.uid, sessionHash, expiresAt: row.expires_at, authenticatedAt: row.authenticated_at };
}

export async function openExportContext(request: Request, recent = false): Promise<ExportContext> {
  const token = cookieToken(request);
  if (!token) throw new MigrationExportError("login_required", "请先登录", 401);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw denied();
  const root = await fs.realpath(process.cwd()), runtime = await readExportConfiguration(root);
  if (connections.active >= 8) throw new MigrationExportError("export_connections_busy", "迁移核对请求过多，请稍后重试", 429);
  connections.active++;
  const client = new Client({ ...runtime.connection, application_name: "alcor-migration-export", connectionTimeoutMillis: 6000, statement_timeout: 300000, options: "-c default_transaction_read_only=on -c row_security=off" });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; try { await client.end(); } finally { connections.active--; } };
  try {
    await client.connect();
    const marker = (await client.query(`SELECT version::text,migration_id::text,active FROM ${quoted(runtime.config.schema)}._database_backend WHERE id=1`)).rows[0];
    if (marker?.version !== "1" || marker.active !== true || marker.migration_id !== runtime.config.migrationId) throw new MigrationExportError("backend_mismatch", "当前 PostgreSQL 业务运行标识未核准");
    const domain = (await client.query(`SELECT value FROM ${quoted(runtime.config.schema)}.site_settings WHERE key='domain'`)).rows[0]?.value;
    const origin = new URL(process.env.FIRE_APP_ORIGIN || (/^https?:\/\//.test(domain || "") ? domain : "https://" + domain)).origin;
    const requestUrl = new URL(request.url), originHeader = request.headers.get("origin");
    if ((request.headers.get("host") || requestUrl.host).toLowerCase() !== new URL(origin).host.toLowerCase() || (originHeader && originHeader !== origin) || (request.method === "POST" && originHeader !== origin) || (process.env.NODE_ENV === "production" && (new URL(origin).protocol !== "https:" || (requestUrl.protocol !== "https:" && request.headers.get("x-forwarded-proto") !== "https")))) throw denied();
    const actor = await verifyLiveActor(client, runtime.config.schema, digest(token), recent);
    const server = (await client.query("SELECT current_setting('server_version') AS version,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid")).rows[0];
    const buildSha = process.env.FIRE_BUILD_SHA?.trim() || "unknown";
    if (process.env.NODE_ENV === "production" && !/^[a-f0-9]{40}$/.test(buildSha)) throw new MigrationExportError("build_unknown", "当前线上构建标识未知，请先核准运行版本");
    const source: ExportSource = { origin, appVersion: CURRENT_VERSION.version, buildSha, backend: "postgres", database: runtime.connection.database, schema: runtime.config.schema, migrationId: marker.migration_id, instanceId: digest([origin, runtime.connection.host, runtime.connection.port, runtime.connection.database, runtime.config.schema, marker.migration_id, server.oid].join("\n")), serverVersion: server.version, driver: "pg" };
    return { root, client, close, actor, source, configurationStamp: runtime.stamp, connection: runtime.connection };
  } catch (error) { await close().catch(() => {}); throw error; }
}

export function assertExpectedSource(value: unknown, source: ExportSource) {
  const keys = Object.keys(source) as Array<keyof ExportSource>;
  if (!value || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some(key => (value as Record<string, unknown>)[key] !== source[key])) throw new MigrationExportError("source_changed", "来源信息已变化，请重新核对后导出");
}
