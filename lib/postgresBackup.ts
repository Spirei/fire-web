import { Client } from "pg";
import fs from "node:fs/promises";
import { identifier } from "./postgresSql";
import type { PostgresConnection } from "./postgresDatabase";

/** A native PostgreSQL SQL snapshot: exact server-rendered values, schema, guards and sequences in one MVCC snapshot. */
export async function backupPostgres(connection: PostgresConnection, file: string) {
  const { schema, ...configuration } = connection;
  const c = new Client({ ...configuration, connectionTimeoutMillis: 6000, application_name: "alcor-backup" });
  const out = await fs.open(file, "wx", 0o600);
  const write = (s: string) => out.write(s + "\n");
  try {
    await c.connect(); await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const s = identifier(schema);
    await write(`-- Alcor PostgreSQL snapshot v1; restore only to an empty database with the original encryption key.\nBEGIN;\nCREATE SCHEMA IF NOT EXISTS ${s};\nSET LOCAL search_path=${s},pg_catalog;`);
    const functions = (await c.query("SELECT pg_get_functiondef(p.oid) AS ddl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.prokind='f' ORDER BY p.proname", [schema])).rows;
    for (const f of functions) await write(f.ddl + ";");
    const tables = (await c.query("SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname", [schema])).rows;
    for (const t of tables) {
      const columns = (await c.query("SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [t.oid])).rows;
      const definitions = columns.map(a => `${identifier(a.attname)} ${a.type}${a.attidentity ? ` GENERATED ${a.attidentity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY` : a.default_value !== null ? " DEFAULT " + a.default_value : ""}${a.attnotnull ? " NOT NULL" : ""}`);
      await write(`CREATE TABLE ${s}.${identifier(t.relname)}(${definitions.join(",")});`);
      // Render JSON and escaping on the server so NUMERIC never passes through a JS Number.
      const data = (await c.query(`SELECT quote_literal(row_to_json(t)::text) AS value FROM ${s}.${identifier(t.relname)} t`)).rows;
      for (const row of data) await write(`INSERT INTO ${s}.${identifier(t.relname)} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(NULL::${s}.${identifier(t.relname)},${row.value}::json);`);
    }
    const constraints = (await c.query("SELECT c.relname,con.conname,con.contype,pg_get_constraintdef(con.oid,true) AS ddl FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND con.contype IN ('p','u','c','f') ORDER BY CASE con.contype WHEN 'f' THEN 1 ELSE 0 END,c.relname,con.conname", [schema])).rows;
    for (const item of constraints) await write(`ALTER TABLE ${s}.${identifier(item.relname)} ADD CONSTRAINT ${identifier(item.conname)} ${item.ddl};`);
    const indexes = (await c.query("SELECT pg_get_indexdef(i.indexrelid) AS ddl FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT EXISTS(SELECT 1 FROM pg_constraint con WHERE con.conindid=i.indexrelid) ORDER BY i.indexrelid", [schema])).rows;
    for (const item of indexes) await write(item.ddl + ";");
    const sequences = (await c.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname", [schema])).rows;
    for (const seq of sequences) {
      const state = (await c.query(`SELECT last_value::text,is_called FROM ${s}.${identifier(seq.relname)}`)).rows[0];
      const name = schema + "." + seq.relname;
      const literal = (await c.query("SELECT quote_literal($1::text) AS name", [name])).rows[0].name;
      await write(`SELECT setval(${literal}::regclass,${state.last_value},${state.is_called ? "true" : "false"});`);
    }
    const views = (await c.query("SELECT c.relname,pg_get_viewdef(c.oid,true) AS ddl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='v' ORDER BY c.relname", [schema])).rows;
    for (const view of views) await write(`CREATE VIEW ${s}.${identifier(view.relname)} AS ${view.ddl};`);
    const triggers = (await c.query("SELECT pg_get_triggerdef(t.oid,true) AS ddl FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname", [schema])).rows;
    for (const item of triggers) await write(item.ddl + ";");
    await write("COMMIT;"); await c.query("COMMIT"); await out.sync();
  } catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await c.end(); await out.close(); }
}
