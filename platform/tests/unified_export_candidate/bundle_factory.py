"""Synthetic ALCORMX1 fixtures, not a real PostgreSQL restore artifact."""

import gzip
import hashlib
import io
import json
import tarfile
from pathlib import Path
from uuid import uuid4

from alcor_api.unified_export_verify import MAGIC, ROOTS
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY = b"s" * 32
assert len(KEY) == 32


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def object_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def parts():
    export_id = "mex_" + uuid4().hex
    table = "tables/" + digest(b"public.records") + ".jsonl"
    original = "files/public/avatars/" + "long-" * 25 + "头像.png"
    entries = {
        "database.dump": b"PGDMP-synthetic-no-SQL-executed",
        "database.toc": b"; synthetic table inventory\n",
        table: b'{"owner":"private-owner-not-for-summary","v":1e-1000,"n":9007199254740993123456789,"unknown":null}\n',
        original: b"synthetic original image bytes",
    }
    info = lambda name: {"path": name, "bytes": str(len(entries[name])), "sha256": digest(entries[name])}
    manifest = {
        "format": "alcor-unified-migration",
        "formatVersion": 1,
        "exportId": export_id,
        "createdAt": "2026-11-03T00:00:00Z",
        "source": {
            "origin": "https://synthetic.invalid",
            "appVersion": "0.1.0",
            "buildSha": "a" * 40,
            "backend": "postgres",
            "database": "private-database-not-for-summary",
            "schema": "public",
            "migrationId": str(uuid4()),
            "instanceId": "b" * 64,
            "serverVersion": "16.9",
            "driver": "pg",
        },
        "snapshot": {
            "isolation": "repeatable-read-read-only",
            "snapshot": "00000001-1",
            "transactions": "1:1:",
            "captured_at": "2026-11-03 00:00:00+00",
            "sequences": [],
            "sequenceStability": "unchanged-through-original-verification",
            "scope": "all-non-system-database-schemas",
            "restoreMode": "isolated-quarantine-only",
        },
        "users": [{"id": "private-owner-not-for-summary", "uid": None}],
        "domains": ["ledger-and-evidence"],
        "tables": [
            {
                **info(table),
                "schema": "public",
                "name": "records",
                "kind": "r",
                "domain": "ledger-and-evidence",
                "columns": [
                    {"name": key, "type": "text", "required": True, "identity": "", "generated": ""}
                    for key in ("owner", "v", "n", "unknown")
                ],
                "rowCount": "1",
                "rowEncoding": "postgres-row_to_json-text-utf8-lf",
            }
        ],
        "database": {**info("database.dump"), "format": "pg_dump-custom", "toc": info("database.toc")},
        "originals": {
            "roots": [{"path": name, "present": name == "public"} for name in ROOTS],
            "files": [info(original)],
            "count": "1",
            "bytes": str(len(entries[original])),
            "registeredLocalReferences": "1",
        },
        "omissions": {
            "businessTables": [],
            "sourceEncryptionKey": "not-included-transfer-separately",
            "connectionConfiguration": "not-included",
            "clusterRolesAndTablespaces": "not-in-database-dump",
            "externalNetworkFetches": "none",
        },
        "preservation": {
            "originalIdsAndExecutionStates": True,
            "financialProjectionReplay": False,
            "financialNumbers": "native-pg-dump-and-server-json-lexemes-no-js-number-roundtrip",
            "unknowns": "unchanged",
            "sourceWrites": False,
        },
        "sourceEncryption": {
            "format": "enc:v1:aes-256-gcm",
            "keyFingerprintSha256": "c" * 64,
            "fingerprintInput": "sha256(sha256(original-key-bytes))",
            "keyIncluded": False,
            "separateOriginalKeyRequired": True,
        },
    }
    return manifest, entries


def tar_bytes(manifest, entries, *, manifest_raw=None, seal_override=None, extra=(), members=None):
    raw_manifest = manifest_raw if manifest_raw is not None else object_bytes(manifest)
    seal = {
        "version": 1,
        "algorithm": "sha256",
        "manifestSha256": digest(raw_manifest),
        "fileCount": str(len(entries)),
    }
    if seal_override:
        seal.update(seal_override)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:

        def add(name, raw):
            item = tarfile.TarInfo(name)
            item.size = len(raw)
            archive.addfile(item, io.BytesIO(raw))

        add("manifest.json", raw_manifest)
        add("seal.json", object_bytes(seal))
        for directory in ["tables", "files", "files/public", "files/public/avatars"]:
            item = tarfile.TarInfo(directory + "/")
            item.type = tarfile.DIRTYPE
            archive.addfile(item)
        if members is not None:
            for item, raw in members:
                archive.addfile(item, io.BytesIO(raw))
        else:
            for name, raw in entries.items():
                add(name, raw)
        for name, raw in extra:
            add(name, raw)
    return output.getvalue()


def encrypt(plaintext, manifest, *, key=KEY, header_patch=None, header_raw=None):
    header = {
        "format": "alcor-unified-migration",
        "version": 1,
        "exportId": manifest["exportId"],
        "cipher": "AES-256-GCM",
        "nonce": "MDEyMzQ1Njc4OWFi",
        "keyDerivation": "none-32-random-bytes",
        "payload": "tar.gz",
    }
    if header_patch:
        header.update(header_patch)
    raw = header_raw if header_raw is not None else json.dumps(header, separators=(",", ":")).encode()
    prefix = MAGIC + len(raw).to_bytes(4, "big") + raw
    return prefix + AESGCM(key).encrypt(b"0123456789ab", plaintext, prefix)


def write_bundle(directory, *, manifest=None, entries=None, tar=None, plaintext=None, header_patch=None):
    if manifest is None:
        manifest, default = parts()
        entries = default if entries is None else entries
    elif entries is None:
        raise ValueError("Explicit manifest requires entries")
    tar = tar_bytes(manifest, entries) if tar is None else tar
    raw = encrypt(
        gzip.compress(tar, mtime=0) if plaintext is None else plaintext, manifest, header_patch=header_patch
    )
    path = Path(directory) / ("bundle-" + uuid4().hex + ".alcor-migration")
    path.write_bytes(raw)
    path.chmod(0o600)
    return path, KEY, manifest
