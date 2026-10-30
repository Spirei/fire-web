import type Database from "better-sqlite3";
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import { bindSql, identifier, postgresSql, postgresTrigger, splitSql, type SqlTableInfo } from "./postgresSql";

export interface PostgresConnection { host: string; port: number; database: string; user: string; password: string; schema: string; ssl?: false | { rejectUnauthorized: boolean }; }
interface Result { rows: Record<string, unknown>[]; rowCount: number; fields: { name: string; dataTypeID: number }[]; }
type GuardKey = "tradeCorrection" | "feeCorrection";
const decode = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  return value;
};
const decodeRows = (result: Result) => { const booleans=new Set(result.fields.filter(f=>f.dataTypeID===16).map(f=>f.name));return result.rows.map(row => Object.fromEntries(Object.entries(row).filter(([k])=>k!=="_alcor_rowid").map(([k,v])=>[k,booleans.has(k) && typeof v === "boolean" ? (v?1:0) : decode(v)]))); };
export class PostgresDatabase {
  readonly __alcorPostgres = true;
  readonly name: string;
  readonly readonly = false;
  readonly memory = false;
  open = true;
  private worker: Worker;
  private port;
  private sequence = 0;
  private depth = 0;
  private tables = new Map<string, SqlTableInfo>();
  private callbacks = new Map<string, (...args: unknown[]) => unknown>();
  private guards: Partial<Record<GuardKey, string[]>> = {};
  constructor(readonly connection: PostgresConnection) {
    identifier(connection.schema);
    this.name = `${connection.host}:${connection.port}/${connection.database}/${connection.schema}`;
    const channel = new MessageChannel(); this.port = channel.port1;
    const workerFile = path.join(process.cwd(), "lib", "postgresWorker.cjs");
    this.worker = new Worker(fs.existsSync(workerFile) ? workerFile : path.join(__dirname, "postgresWorker.cjs"), { workerData: {
      port: channel.port2, connection: { ...connection, schema: undefined,
        connectionTimeoutMillis: 6000, application_name: "alcor-business", options: `-c search_path=${connection.schema},pg_catalog -c statement_timeout=12000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=20000` }
    }, transferList: [channel.port2] });
    this.worker.on("error", () => { this.open = false; });
    this.worker.unref(); this.port.unref();
  }
  get inTransaction() { return this.depth > 0; }
  private rpc(sql: string, values: unknown[] = [], op = "query"): Result[] {
    if (!this.open) throw Error("PostgreSQL 连接已关闭；未回退本地数据库");
    const id = ++this.sequence, signal = new SharedArrayBuffer(4), state = new Int32Array(signal);
    this.port.postMessage({ id, signal, sql, values, op, guards: this.guards });
    if (Atomics.wait(state, 0, 0, 20000) === "timed-out") {
      this.open = false; void this.worker.terminate();
      throw Object.assign(Error("数据库读取超时；写入结果未知时请查询原 requestId 回执"), { code: "ALCOR_DATABASE_UNKNOWN" });
    }
    const response = receiveMessageOnPort(this.port)?.message;
    if (!response || response.id !== id) { this.open = false; void this.worker.terminate(); throw Error("PostgreSQL 响应不完整"); }
    if (response.error) {
      if (["ECONNRESET", "EPIPE", "08003", "08006", "57P01"].includes(response.error.code) || /Connection terminated|Client was closed/i.test(response.error.message)) this.open = false;
      const fn = /^alcor:(\w+)$/.exec(response.error.message)?.[1]; if (fn && this.callbacks.has(fn)) this.callbacks.get(fn)!();
      const error = Object.assign(Error(response.error.message), { ...response.error });
      if (response.error.code === "23505") error.code = "SQLITE_CONSTRAINT_UNIQUE";
      if (response.error.code === "23503") error.code = "SQLITE_CONSTRAINT_FOREIGNKEY";
      if (response.error.code === "23514") error.code = "SQLITE_CONSTRAINT_CHECK";
      throw error;
    }
    return response.value;
  }
  /** Maintenance SQL already uses PostgreSQL placeholders. Never pass browser input as SQL. */
  raw(sql: string, values: unknown[] = []): Result { return this.rpc(sql, values).at(-1) ?? { rows: [], rowCount: 0, fields: [] }; }
  tableInfo(name: string): SqlTableInfo {
    if (!this.tables.has(name)) {
      const rows = this.raw(`SELECT a.attname AS name,EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS pk FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'_alcor_rowid' ORDER BY a.attnum`, [this.connection.schema + "." + name]).rows;
      this.tables.set(name, { columns: rows.map(r => String(r.name)), primaryKey: rows.filter(r => r.pk).map(r => String(r.name)) });
    }
    return this.tables.get(name)!;
  }
  prepare(source: string) {
    const self = this;
    const writes = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(source);
    const run = (args: unknown[]) => {
      const pragma = /^\s*PRAGMA\s+table_info\s*\(\s*["`]?([\w]+)["`]?\s*\)\s*;?\s*$/i.exec(source);
      if (pragma) return { rows: self.pragma(`table_info(${pragma[1]})`) as Record<string, unknown>[], rowCount: 0, fields: [] };
      const bound = bindSql(postgresSql(source, n => self.tableInfo(n)), args);
      return self.raw(bound.sql, bound.values);
    };
    return {
      source, database: this,
      all(...args: unknown[]) { return decodeRows(writes ? self.transaction(() => run(args))() : run(args)); },
      get(...args: unknown[]) { return decodeRows(writes ? self.transaction(() => run(args))() : run(args))[0]; },
      // SQLite ABORT rolls back a statement, leaving the surrounding transaction usable.
      run(...args: unknown[]) { const r = self.transaction(() => run(args))(); return { changes: r.rowCount, lastInsertRowid: 0 }; }
    };
  }
  exec(source: string) {
    for (const sql of splitSql(source)) {
      if (/^CREATE\s+TRIGGER\b/i.test(sql)) {
        const trigger = postgresTrigger(sql, this.connection.schema);
        if (trigger.ifNotExists && this.raw("SELECT 1 FROM pg_trigger WHERE tgname=$1 AND tgrelid=to_regclass($2)", [trigger.name, this.connection.schema + "." + trigger.table]).rows.length) continue;
        this.raw(trigger.sql);
        this.recordSchema("trigger", trigger.name, trigger.table, sql);
      } else if (/^DROP\s+TRIGGER\b/i.test(sql)) {
        const name = sql.split(/\s+/).at(-1)!.replace(/["`]/g, "");
        const found = this.raw("SELECT c.relname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE t.tgname=$1 AND n.nspname=$2", [name, this.connection.schema]).rows;
        for (const table of found) this.raw(`DROP TRIGGER ${identifier(name)} ON ${identifier(String(table.name))}`);
        this.raw("DELETE FROM _sqlite_schema WHERE type='trigger' AND name=$1", [name]);
      } else {
        const translated = postgresSql(sql, name => this.tableInfo(name));
        this.raw(/^CREATE\s+TABLE\b/i.test(sql) ? translated.replace(/\)\s*$/, ', _alcor_rowid BIGINT GENERATED BY DEFAULT AS IDENTITY)') : translated);
        const table = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)/i.exec(sql)?.[1];
        if (table) this.recordSchema("table", table, table, sql);
        if (/^(?:CREATE|ALTER|DROP)\b/i.test(sql)) this.tables.clear();
      }
    }
    return this;
  }
  private recordSchema(type: string, name: string, table: string, sql: string) {
    this.raw("INSERT INTO _sqlite_schema(type,name,tbl_name,sql) VALUES($1,$2,$3,$4) ON CONFLICT(type,name) DO UPDATE SET sql=excluded.sql,tbl_name=excluded.tbl_name", [type, name, table, sql]);
  }
  pragma(source: string, options?: { simple?: boolean }) {
    const info = /^table_info\s*\(\s*["`]?([\w]+)["`]?\s*\)$/i.exec(source);
    if (info) {
      const table = info[1], pk = this.tableInfo(table).primaryKey;
      return this.raw(`SELECT ordinal_position-1 AS cid,column_name AS name,CASE data_type WHEN 'numeric' THEN 'REAL' WHEN 'bigint' THEN 'INTEGER' WHEN 'bytea' THEN 'BLOB' ELSE 'TEXT' END AS type,CASE is_nullable WHEN 'NO' THEN 1 ELSE 0 END AS "notnull",column_default AS dflt_value,0 AS pk FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name<>'_alcor_rowid' ORDER BY ordinal_position`, [this.connection.schema, table]).rows.map(r => ({ ...r, pk: pk.indexOf(String(r.name)) + 1 }));
    }
    if (/^schema_version$/i.test(source)) { const version = Number(this.raw("SELECT count(*) AS n FROM _sqlite_schema").rows[0].n); return options?.simple ? version : [{ schema_version: version }]; }
    if (/^foreign_keys(?:\s*=\s*(?:ON|1))?$/i.test(source)) return options?.simple ? 1 : [{ foreign_keys: 1 }];
    throw Error("Unsupported PostgreSQL pragma: " + source);
  }
  transaction<T extends (...args: never[]) => unknown>(fn: T) {
    const execute = (...args: Parameters<T>): ReturnType<T> => {
      const nested = this.depth > 0, savepoint = "alcor_" + this.depth;
      this.raw(nested ? `SAVEPOINT ${savepoint}` : "BEGIN ISOLATION LEVEL READ COMMITTED");
      // Serialize application write/read-modify-write sequences across server instances.
      if (!nested) this.raw("SELECT pg_advisory_xact_lock(hashtext(current_database()||':alcor-business'))");
      this.depth++;
      try {
        const value = fn(...args);
        if (value && typeof (value as Promise<unknown>).then === "function") throw Error("Database transaction callback must be synchronous");
        this.raw(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT"); return value as ReturnType<T>;
      } catch (error) { if (this.open) { try { this.raw(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK"); if (nested) this.raw(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* Retain the original error, including an unknown write outcome. */ } } throw error; }
      finally { this.depth--; }
    };
    return Object.assign(execute, { immediate: execute, deferred: execute, exclusive: execute });
  }
  function(name: string, fn: (...args: unknown[]) => unknown) {
    if (!["broker_cash_conflict", "broker_source_conflict", "trade_correction_conflict", "broker_cash_fee_correction", "trade_correction_allowed"].includes(name)) throw Error("Unsupported database function " + name);
    this.callbacks.set(name, fn); return this;
  }
  setGuardContext(key: GuardKey, ids: ReadonlySet<string> | undefined) { if (ids) this.guards[key] = [...ids]; else delete this.guards[key]; }
  close() { try { if (this.open) this.rpc("", [], "close"); } finally { this.open = false; this.port.close(); void this.worker.terminate(); } }
  asDatabase(): Database.Database { return this as unknown as Database.Database; }
}
export function postgresHandle(db: Database.Database): PostgresDatabase | null { return (db as unknown as { __alcorPostgres?: boolean }).__alcorPostgres ? db as unknown as PostgresDatabase : null; }
