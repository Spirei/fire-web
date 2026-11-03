import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { MigrationExportError, inventoryOriginals, copyOriginals, assertReferences, localReferences, hashOriginal } from "./migrationExportFiles";
import { quoted, readExportConfiguration, verifyLiveActor, type ExportContext } from "./migrationExportSource";

export const MIGRATION_MAGIC = Buffer.from("ALCORMX1");
export const migrationKey = (encoded: unknown): Buffer => {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new MigrationExportError("export_key_invalid", "请提供独立生成的 32 字节导出密钥", 400);
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) throw new MigrationExportError("export_key_invalid", "导出密钥格式无效", 400);
  return key;
};
const sha = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
export function postgresTool(name: "pg_dump" | "pg_restore") { return process.env.ALCOR_PG_BIN ? path.join(process.env.ALCOR_PG_BIN, name) : name; }

export function runTool(command: string, args: string[], env: Record<string, string | undefined>) {
  const child = spawn(command, args, { env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(30 * 60_000) });
  let stderr = false;
  child.stderr.on("data", () => { stderr = true; }); // Drain but never persist database diagnostics/credentials.
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new MigrationExportError("export_tool_unavailable", "迁移导出工具不可用")));
    child.once("close", code => code === 0 && !stderr ? resolve() : reject(new MigrationExportError("export_tool_failed", "导出工具报告错误或警告；未发布不完整导出")));
  });
  void done.catch(() => {});
  return { child, done };
}
async function toolOutput(command: string, args: string[], env: Record<string, string | undefined>) {
  const { child, done } = runTool(command, args, env); let output = "";
  for await (const part of child.stdout) { output += part.toString("utf8"); if (output.length > 16 * 1024 * 1024) { child.kill(); throw new MigrationExportError("tool_output_large", "导出工具输出超出限制"); } }
  await done; return output;
}

const domain = (table: string) => /^(records|trade_|fund_|broker_|app_trading|order_|asset_order|allocation_|asset_allocation|source_|historical_|migration_|reconciliation_|.*correction|.*fee)/.test(table) ? "ledger-and-evidence"
  : /^(users|sessions|app_|passkey|totp|password_|email_|user_)/.test(table) ? "identity-and-app-state"
  : /^(resource_|assets|card_|attachment|celebs)/.test(table) ? "originals-and-library"
  : /^(feed_|assistant_|notification|price_alert)/.test(table) ? "feed-and-notifications" : "other-preserved";

/** A complete native dump plus lossless server-encoded row sidecars, all from one exported MVCC snapshot. */
export async function buildMigrationBundle(context: ExportContext, directory: string, exportId: string, encryptionKey: Buffer, progress: (stage: string) => Promise<void>) {
  const { client, source } = context;
  const staging = path.join(directory, "staging");
  await fs.mkdir(staging, { mode: 0o700 }); await fs.mkdir(path.join(staging, "tables"), { mode: 0o700 });
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, DYLD_LIBRARY_PATH: process.env.ALCOR_PG_DYLD_LIBRARY_PATH || process.env.DYLD_LIBRARY_PATH, LC_ALL: "C", TZ: "UTC", PGHOST: context.connection.host, PGPORT: String(context.connection.port), PGUSER: context.connection.user, PGDATABASE: context.connection.database, PGPASSWORD: context.connection.password, PGCONNECT_TIMEOUT: "6", PGSSLMODE: "disable", PGOPTIONS: "-c default_transaction_read_only=on -c row_security=off -c statement_timeout=1800000" };
  let transaction = false;
  try {
    const major = source.serverVersion.match(/^(\d+)/)?.[1];
    for (const name of ["pg_dump", "pg_restore"] as const) {
      const version = await toolOutput(postgresTool(name), ["--version"], env);
      if (version.match(/\(PostgreSQL\) (\d+)/)?.[1] !== major) throw new MigrationExportError("client_version_mismatch", "PostgreSQL 导出工具与源服务器主版本不一致");
    }
    await progress("checking-originals");
    const inventory = await inventoryOriginals(context.root);
    const originalBytes = inventory.files.reduce((total, file) => total + BigInt(file.bytes), 0n);
    if (inventory.files.length > 190000 || originalBytes > 10n * 1024n ** 3n) throw new MigrationExportError("export_capacity", "完整原件超出当前导出容量，未省略任何文件");
    const databaseBytes = BigInt((await client.query("SELECT pg_database_size(current_database())::text AS bytes")).rows[0].bytes);
    const disk = await fs.statfs(directory, { bigint: true });
    if (disk.bavail * disk.bsize < originalBytes * 2n + databaseBytes * 4n + 67108864n) throw new MigrationExportError("export_disk_full", "导出保存空间不足；未修改或清理既有备份");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    const point = (await client.query("SELECT pg_export_snapshot() AS snapshot,txid_current_snapshot()::text AS transactions,clock_timestamp()::text AS captured_at")).rows[0];
    const marker = (await client.query(`SELECT migration_id::text,active FROM ${quoted(source.schema)}._database_backend WHERE id=1`)).rows[0];
    if (marker?.migration_id !== source.migrationId || marker.active !== true) throw new MigrationExportError("backend_mismatch", "快照中的业务运行标识未核准");
    const tables = (await client.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND c.relkind IN ('r','p','m','f') ORDER BY n.nspname,c.relname")).rows;
    if (tables.some(table => table.kind === "f")) throw new MigrationExportError("foreign_table_unsupported", "存在无法封印原件的外部表，请先完成来源核准");
    const sequences = async () => {
      const names = (await client.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname<>'information_schema' AND n.nspname!~'^pg_' ORDER BY n.nspname,c.relname")).rows;
      const result = [];
      for (const item of names) {
        const state = (await client.query(`SELECT last_value::text AS value,is_called FROM ${quoted(item.schema)}.${quoted(item.name)}`)).rows[0];
        result.push({ ...item, ...state });
      }
      return result;
    };
    const sequenceBefore = await sequences();
    await progress("snapshot-open");
    const references = new Set<string>(), tableManifest = [];
    for (const table of tables) {
      const target = `${quoted(table.schema)}.${quoted(table.name)}`;
      const columns = (await client.query("SELECT attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required,attidentity AS identity,attgenerated AS generated FROM pg_attribute WHERE attrelid=$1::oid AND attnum>0 AND NOT attisdropped ORDER BY attnum", [table.oid])).rows;
      const name = `tables/${sha(JSON.stringify([table.schema, table.name]))}.jsonl`, out = await fs.open(path.join(staging, name), "wx", 0o600);
      const hash = createHash("sha256"); let count = 0n;
      try {
        await client.query(`DECLARE migration_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS value FROM ONLY ${target} t ORDER BY row_to_json(t)::text COLLATE "C"`);
        for (;;) {
          const rows = (await client.query("FETCH FORWARD 500 FROM migration_rows")).rows;
          if (!rows.length) break;
          for (const row of rows) {
            // Do not JSON.parse a row: NUMERIC/BIGINT and unknown/null remain exact native lexemes.
            const bytes = Buffer.from(row.value + "\n", "utf8"); await out.writeFile(bytes); hash.update(bytes); count++;
            for (const reference of localReferences(row.value, source.origin)) references.add(reference);
          }
        }
        await client.query("CLOSE migration_rows"); await out.sync();
      } finally { await out.close(); }
      tableManifest.push({ schema: table.schema, name: table.name, kind: table.kind, domain: domain(table.name), columns, rowCount: count.toString(), path: name, sha256: hash.digest("hex"), bytes: (await fs.stat(path.join(staging, name), { bigint: true })).size.toString(), rowEncoding: "postgres-row_to_json-text-utf8-lf" });
    }
    assertReferences(references, inventory);
    // Ready resource originals are private and use derived physical names, not public URLs.
    const resourceTable = tables.find(table => table.schema === source.schema && table.name === "resource_files");
    if (resourceTable) {
      const originals = new Map(inventory.files.map(file => [file.path, file]));
      for (const row of (await client.query(`SELECT id,user_id,state,sha256,size_bytes::text FROM ${quoted(source.schema)}.resource_files WHERE state<>'deleted'`)).rows) {
        const file = originals.get(`data/resource-library/${sha(row.user_id)}/${row.id}`);
        if (row.state !== "ready" || !file || file.sha256 !== row.sha256 || file.bytes !== row.size_bytes) throw new MigrationExportError("resource_original_invalid", "已登记资源原件缺失、未完成或校验不符");
      }
    }
    // A remote logo reference is not an original file. Do not silently declare a complete media export.
    for (const table of tableManifest) {
      const originalFields = table.columns.filter(column => ["avatar", "image_url", "cover_url"].includes(column.name) || (table.name === "assets" && ["url", "url_dark"].includes(column.name)));
      for (const column of originalFields) {
        const values = (await client.query(`SELECT ${quoted(column.name)}::text AS value FROM ${quoted(table.schema)}.${quoted(table.name)} WHERE ${quoted(column.name)}::text ~ '^https?://'`)).rows;
        if (values.some(row => new URL(row.value).origin !== source.origin)) throw new MigrationExportError("external_original_unsealed", "存在未归档的外部图片原件，请先将已登记图片归档并核准后导出");
      }
      for (const column of table.columns.filter(column => ["file_path", "storage_path", "local_path", "original_path"].includes(column.name))) {
        for (const row of (await client.query(`SELECT ${quoted(column.name)}::text AS value FROM ${quoted(table.schema)}.${quoted(table.name)} WHERE ${quoted(column.name)} IS NOT NULL AND ${quoted(column.name)}::text<>''`)).rows) {
          let name: string = row.value;
          if (name.startsWith(context.root + path.sep)) name = name.slice(context.root.length + 1);
          if (name.startsWith("/uploads/")) { for (const reference of localReferences(JSON.stringify(name), source.origin)) references.add(reference); continue; }
          if (name.startsWith("uploads/")) name = "public/" + name;
          if (!inventory.files.some(file => file.path === name)) throw new MigrationExportError("registered_original_missing", "已登记原件路径缺失或超出支持范围；未静默跳过");
          references.add(name);
        }
      }
    }
    assertReferences(references, inventory);
    const users = (await client.query(`SELECT id::text,uid::text FROM ${quoted(source.schema)}.users ORDER BY id::text COLLATE "C"`)).rows;
    await progress("dumping-database");
    const dump = path.join(staging, "database.dump"); await fs.writeFile(dump, "", { flag: "wx", mode: 0o600 });
    const dbname = context.connection.database.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    await toolOutput(postgresTool("pg_dump"), ["--format=custom", "--encoding=UTF8", "--no-password", "--lock-wait-timeout=5000", `--dbname=dbname='${dbname}'`, `--snapshot=${point.snapshot}`, `--file=${dump}`], env);
    const toc = await toolOutput(postgresTool("pg_restore"), ["--list", dump], env);
    await fs.writeFile(path.join(staging, "database.toc"), toc, { flag: "wx", mode: 0o600 });
    await progress("copying-originals");
    await fs.mkdir(path.join(staging, "files"), { mode: 0o700 });
    await copyOriginals(context.root, path.join(staging, "files"), inventory);
    if (JSON.stringify(sequenceBefore) !== JSON.stringify(await sequences())) throw new MigrationExportError("sequence_changed", "导出期间编号序列发生变化，请重新导出");
    await client.query("COMMIT"); transaction = false;
    const finalConfiguration = await readExportConfiguration(context.root);
    if (sha(encryptionKey) === finalConfiguration.keyFingerprint || sha(Buffer.from(sha(encryptionKey), "hex")) === finalConfiguration.keyFingerprint) throw new MigrationExportError("export_key_not_independent", "导出密钥必须独立生成，不能复用原库密钥");
    if (finalConfiguration.stamp !== context.configurationStamp) throw new MigrationExportError("source_changed", "导出期间源运行配置发生变化");
    const liveMarker = (await client.query(`SELECT migration_id::text,active FROM ${quoted(source.schema)}._database_backend WHERE id=1`)).rows[0];
    if (liveMarker?.migration_id !== source.migrationId || liveMarker.active !== true) throw new MigrationExportError("backend_mismatch", "导出期间业务运行标识发生变化");
    await verifyLiveActor(client, source.schema, context.actor.sessionHash, true);
    const dumpFile = await hashOriginal(staging, "database.dump"), tocFile = await hashOriginal(staging, "database.toc");
    const payloadBytes = tableManifest.reduce((total, table) => total + BigInt(table.bytes), 0n) + originalBytes + BigInt(dumpFile.bytes) + BigInt(tocFile.bytes);
    if (payloadBytes > 10n * 1024n ** 3n - 67108864n) throw new MigrationExportError("export_capacity", "完整迁移内容超出当前导出容量，未省略任何数据");
    const manifest = {
      format: "alcor-unified-migration", formatVersion: 1, exportId, createdAt: new Date().toISOString(), source,
      snapshot: { isolation: "repeatable-read-read-only", ...point, sequences: sequenceBefore, sequenceStability: "unchanged-through-original-verification", scope: "all-non-system-database-schemas", restoreMode: "isolated-quarantine-only" },
      users, domains: [...new Set(tableManifest.map(table => table.domain))], tables: tableManifest,
      database: { path: dumpFile.path, bytes: dumpFile.bytes, sha256: dumpFile.sha256, format: "pg_dump-custom", toc: { path: tocFile.path, bytes: tocFile.bytes, sha256: tocFile.sha256 } },
      originals: { roots: inventory.roots, files: inventory.files.map(({ stamp: _stamp, ...file }) => ({ ...file, path: "files/" + file.path })), count: String(inventory.files.length), bytes: inventory.files.reduce((total, file) => total + BigInt(file.bytes), 0n).toString(), registeredLocalReferences: String(references.size) },
      omissions: { businessTables: [], sourceEncryptionKey: "not-included-transfer-separately", connectionConfiguration: "not-included", clusterRolesAndTablespaces: "not-in-database-dump", externalNetworkFetches: "none" },
      preservation: { originalIdsAndExecutionStates: true, financialProjectionReplay: false, financialNumbers: "native-pg-dump-and-server-json-lexemes-no-js-number-roundtrip", unknowns: "unchanged", sourceWrites: false },
      sourceEncryption: { format: "enc:v1:aes-256-gcm", keyFingerprintSha256: finalConfiguration.keyFingerprint, fingerprintInput: "sha256(sha256(original-key-bytes))", keyIncluded: false, separateOriginalKeyRequired: true }
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    const manifestSha256 = sha(manifestBytes);
    await fs.writeFile(path.join(staging, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    await fs.writeFile(path.join(staging, "seal.json"), JSON.stringify({ version: 1, algorithm: "sha256", manifestSha256, fileCount: String(tableManifest.length + inventory.files.length + 2) }) + "\n", { flag: "wx", mode: 0o600 });
    await progress("encrypting");
    const header = Buffer.from(JSON.stringify({ format: "alcor-unified-migration", version: 1, exportId, cipher: "AES-256-GCM", nonce: randomBytes(12).toString("base64url"), keyDerivation: "none-32-random-bytes", payload: "tar.gz" }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    const prefix = Buffer.concat([MIGRATION_MAGIC, length, header]);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, Buffer.from(JSON.parse(header.toString()).nonce, "base64url")); cipher.setAAD(prefix);
    const encrypted = await fs.open(path.join(directory, "bundle.partial"), "wx", 0o600);
    const archive = runTool("tar", ["--format=pax", "--no-xattrs", "--no-acls", "-czf", "-", "-C", staging, "--", "manifest.json", "seal.json", "database.dump", "database.toc", "tables", "files"], { PATH: process.env.PATH, LC_ALL: "C", COPYFILE_DISABLE: "1" });
    try {
      await encrypted.writeFile(prefix);
      for await (const chunk of archive.child.stdout) await encrypted.writeFile(cipher.update(chunk));
      await archive.done; await encrypted.writeFile(cipher.final()); await encrypted.writeFile(cipher.getAuthTag()); await encrypted.sync();
    } catch (error) { archive.child.kill(); throw error; }
    finally { await encrypted.close(); }
    if ((await readExportConfiguration(context.root)).stamp !== context.configurationStamp) throw new MigrationExportError("source_changed", "封装期间源运行配置发生变化");
    const publishMarker = (await client.query(`SELECT migration_id::text,active FROM ${quoted(source.schema)}._database_backend WHERE id=1`)).rows[0];
    if (publishMarker?.migration_id !== source.migrationId || publishMarker.active !== true) throw new MigrationExportError("backend_mismatch", "封装期间业务运行标识发生变化");
    await verifyLiveActor(client, source.schema, context.actor.sessionHash, true);
    await fs.rename(path.join(directory, "bundle.partial"), path.join(directory, "bundle.alcor-migration"));
    const bundle = await hashOriginal(directory, "bundle.alcor-migration");
    return { manifestSha256, sha256: bundle.sha256, bytes: bundle.bytes, tables: String(tableManifest.length), originals: String(inventory.files.length), source };
  } finally {
    if (transaction) await client.query("ROLLBACK").catch(() => {});
    await fs.rm(staging, { recursive: true, force: true });
    await fs.unlink(path.join(directory, "bundle.partial")).catch(() => {});
  }
}
