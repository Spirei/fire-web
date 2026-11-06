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