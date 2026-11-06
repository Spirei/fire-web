"""Offline authenticated archive boundaries; no PostgreSQL, extraction or supplier IO."""

import gzip
import hashlib
import json
import os
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest
from alcor_api import unified_export_verify as verifier
from alcor_api.unified_export_verify import DEFAULT_LIMITS, VerificationFailure, verify

from unified_export_candidate.bundle_factory import (
    KEY,
    digest,
    encrypt,
    object_bytes,
    parts,
    tar_bytes,
    write_bundle,
)


def rejected(path, key=KEY, limits=DEFAULT_LIMITS):
    with pytest.raises(VerificationFailure) as error:
        verify(path, key, limits)
    assert str(path) not in str(error.value) and "private-owner" not in str(error.value)
    return error.value.code


def test_valid_pax_unicode_and_original_numeric_bytes_are_only_summarized(tmp_path):
    path, key, manifest = write_bundle(tmp_path)
    before = path.read_bytes()
    files = set(tmp_path.iterdir())
    result = verify(path, key, replace(DEFAULT_LIMITS, temporary_directory=tmp_path))
    assert (
        result["state"] == "verified_not_applied"
        and result["applied"] is False
        and result["sqlExecuted"] is False
    )
    assert result["bundleSha256"] == digest(before) and result["manifestSha256"] == digest(
        object_bytes(manifest)
    )
    assert result["rowCount"] == "1" and result["tableCount"] == 1 and result["originalFileCount"] == 1
    assert result["sourceIdentity"] == "self_declared_not_authenticated"
    assert "private-owner" not in json.dumps(result) and "private-database" not in json.dumps(result)
    assert path.read_bytes() == before and set(tmp_path.iterdir()) == files


def test_authentication_finishes_before_any_archive_processing(tmp_path, monkeypatch):
    path, key, _ = write_bundle(tmp_path)

    def forbidden(*args):
        raise AssertionError("Unverified ciphertext must not reach decompression/tar")

    monkeypatch.setattr(verifier, "decompress", forbidden)
    assert rejected(path, b"x" * 32) == "authentication_failed"
    raw = bytearray(path.read_bytes())
    raw[-1] ^= 1
    path.write_bytes(raw)
    assert rejected(path, key) == "authentication_failed"


def test_table_sidecars_follow_manifest_and_do_not_conflate_dotted_identifiers(tmp_path):
    import copy

    manifest, entries = parts()
    template = manifest["tables"][0]
    raw = entries.pop(template["path"])
    tables = []
    for schema, name in (("a.b", "c"), ("a", "b.c")):
        table = copy.deepcopy(template)
        opaque = "tables/" + digest(json.dumps([schema, name], separators=(",", ":")).encode()) + ".jsonl"
        table.update(schema=schema, name=name, path=opaque)
        tables.append(table)
        entries[opaque] = raw
    assert tables[0]["path"] != tables[1]["path"]
    manifest["tables"] = tables
    path, key, _ = write_bundle(tmp_path, manifest=manifest, entries=entries)
    result = verify(path, key)
    assert result["tableCount"] == 2 and result["rowCount"] == "2"
    # Even matching table payloads may not alias a single archive member.
    manifest["tables"][1]["path"] = manifest["tables"][0]["path"]
    path, key, _ = write_bundle(tmp_path, manifest=manifest, entries=entries)
    assert rejected(path, key) == "duplicate_path"


def test_header_shape_versions_duplicates_nonce_and_real_export_id_are_strict(tmp_path):
    for patch in (
        {"version": True},
        {"version": 1.0},
        {"version": "1"},
        {"cipher": "unknown"},
        {"nonce": "bad"},
        {"exportId": "12345678-1234-1234-1234-123456789012"},
        {"unexpected": "ignored"},
    ):
        path, key, _ = write_bundle(tmp_path, header_patch=patch)
        assert rejected(path, key) == "header_contract"
    manifest, entries = parts()
    raw = (
        json.dumps(
            {
                "format": "alcor-unified-migration",
                "version": 1,
                "exportId": manifest["exportId"],
                "cipher": "AES-256-GCM",
                "nonce": "MDEyMzQ1Njc4OWFi",
                "keyDerivation": "none-32-random-bytes",
                "payload": "tar.gz",
            }
        )
        .replace('"version": 1', '"version": 1, "version": 1')
        .encode()
    )
    path = tmp_path / "duplicate-header"
    path.write_bytes(encrypt(gzip.compress(tar_bytes(manifest, entries)), manifest, header_raw=raw))
    assert rejected(path) == "invalid_bundle"


def test_manifest_seal_counts_columns_missing_and_extra_bytes_fail_closed(tmp_path):
    for change in (
        "seal",
        "rows",
        "columns",
        "digest",
        "bytes",
        "missing",
        "extra",
        "source",
        "encryption",
        "manifestversion",
        "sealversion",
    ):
        manifest, entries = parts()
        seal = None
        extra = ()
        if change == "seal":
            seal = {"manifestSha256": "0" * 64}
        elif change == "rows":
            manifest["tables"][0]["rowCount"] = "2"
        elif change == "columns":
            manifest["tables"][0]["columns"] = manifest["tables"][0]["columns"][:1]
        elif change == "digest":
            manifest["database"]["sha256"] = "0" * 64
        elif change == "bytes":
            manifest["database"]["bytes"] = str(len(entries["database.dump"]) + 1)
        elif change == "missing":
            del entries["database.toc"]
        elif change == "extra":
            extra = (("files/public/unlisted", b"not declared"),)
        elif change == "source":
            manifest["source"].pop("instanceId")
        elif change == "encryption":
            manifest["sourceEncryption"]["keyFingerprintSha256"] = "bad"
        elif change == "manifestversion":
            manifest["formatVersion"] = True
        elif change == "sealversion":
            seal = {"version": True}
        path, key, _ = write_bundle(
            tmp_path,
            manifest=manifest,
            entries=entries,
            tar=tar_bytes(manifest, entries, seal_override=seal, extra=extra),
        )
        rejected(path, key)


def test_unsafe_links_devices_pax_and_duplicate_effective_paths_are_rejected(tmp_path):
    import tarfile

    for kind in (
        "dotdot",
        "absolute",
        "symlink",
        "hardlink",
        "fifo",
        "device",
        "sparse",
        "pax",
        "duplicate",
        "casefold",
    ):
        manifest, entries = parts()
        item = tarfile.TarInfo("files/public/unsafe")
        raw = b""
        if kind == "dotdot":
            item.name = "../outside"
        elif kind == "absolute":
            item.name = "/outside"
        elif kind == "symlink":
            item.type = tarfile.SYMTYPE
            item.linkname = "../../outside"
        elif kind == "hardlink":
            item.type = tarfile.LNKTYPE
            item.linkname = "database.dump"
        elif kind == "fifo":
            item.type = tarfile.FIFOTYPE
        elif kind == "device":
            item.type = tarfile.CHRTYPE
        elif kind == "sparse":
            item.type = tarfile.GNUTYPE_SPARSE
        elif kind == "pax":
            item.pax_headers = {"path": "../../outside"}
        elif kind == "duplicate":
            item.name = "manifest.json"
        elif kind == "casefold":
            item.name = "MANIFEST.JSON"
        members = []
        for name, content in entries.items():
            regular = tarfile.TarInfo(name)
            regular.size = len(content)
            members.append((regular, content))
        members.append((item, raw))
        path, key, _ = write_bundle(
            tmp_path, manifest=manifest, entries=entries, tar=tar_bytes(manifest, entries, members=members)
        )
        rejected(path, key)
    assert not (tmp_path.parent / "outside").exists()


def test_single_gzip_only_and_tar_ending_cannot_hide_extra_payload(tmp_path):
    manifest, entries = parts()
    tar = tar_bytes(manifest, entries)
    for plaintext in (
        gzip.compress(tar) + gzip.compress(tar),
        gzip.compress(tar) + b"junk",
        gzip.compress(tar + tar),
        gzip.compress(tar)[:-1],
    ):
        path, key, _ = write_bundle(tmp_path, manifest=manifest, entries=entries, plaintext=plaintext)
        rejected(path, key)
    path, key, _ = write_bundle(tmp_path, manifest=manifest, entries=entries, tar=tar + b"nonzero trailer")
    rejected(path, key)


def test_budgets_and_jsonl_object_lf_counts_and_numeric_errors_are_bounded(tmp_path):
    path, key, _ = write_bundle(tmp_path)
    for limits in (
        replace(DEFAULT_LIMITS, max_bundle_bytes=32),
        replace(DEFAULT_LIMITS, max_members=3),
        replace(DEFAULT_LIMITS, max_total_bytes=100),
        replace(DEFAULT_LIMITS, max_header_bytes=1),
        replace(DEFAULT_LIMITS, max_jsonl_line_bytes=16),
    ):
        rejected(path, key, limits)
    for line in (
        b"[]\n",
        b'{"owner":null}\r\n',
        b'{"owner":null}',
        b'{"owner":1,"owner":2}\n',
        b'{"owner":1e99999999999999999999999999999999999999999}\n',
    ):
        manifest, entries = parts()
        name = manifest["tables"][0]["path"]
        entries[name] = line
        manifest["tables"][0].update(bytes=str(len(line)), sha256=digest(line))
        invalid, key, _ = write_bundle(tmp_path, manifest=manifest, entries=entries)
        rejected(invalid, key)
    manifest, entries = parts()
    path, key, _ = write_bundle(
        tmp_path, manifest=manifest, entries=entries, plaintext=gzip.compress(b"\0" * (2 * 1024**2))
    )
    assert rejected(path, key, replace(DEFAULT_LIMITS, max_expansion_ratio=1)) == "expanded_budget"


def test_input_symlink_fifo_and_change_during_verification_are_rejected(tmp_path, monkeypatch):
    path, key, _ = write_bundle(tmp_path)
    link = tmp_path / "alias"
    link.symlink_to(path)
    rejected(link, key)
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    assert rejected(fifo, key) == "input_file"  # O_NONBLOCK: must not wait for a producer.
    original = verifier.check_tar

    def changed(*args):
        result = original(*args)
        path.write_bytes(b"changed synthetic input")
        return result

    monkeypatch.setattr(verifier, "check_tar", changed)
    assert rejected(path, key) == "input_changed"


def test_actual_old_web_manifest_and_encryption_fragment_interoperates_with_real_tar(
    tmp_path, record_property
):
    # Frozen actual producer fragments make this oracle executable in a fresh clone.
    # An explicit external checkout remains optional for local producer integration.
    fixture = Path(__file__).parent / "fixtures" / "old_web_producer"
    provenance = json.loads((fixture / "provenance.json").read_text())
    for name, sha in provenance["fragments"].items():
        assert hashlib.sha256((fixture / name).read_bytes()).hexdigest() == sha
    legacy = os.environ.get("ALCOR_MARKET_LEGACY_ROOT")
    if legacy:
        root = Path(legacy)
        snapshot = (root / "lib/migrationExportSnapshot.ts").read_text()
        job = (root / "lib/migrationExport.ts").read_text()
        record_property("oldSnapshotSha256", hashlib.sha256(snapshot.encode()).hexdigest())
        record_property("oldJobSha256", hashlib.sha256(job.encode()).hexdigest())
    else:
        snapshot = None
        job = None
        record_property("oldSnapshotSha256", provenance["sourceFiles"]["lib/migrationExportSnapshot.ts"])
        record_property("oldJobSha256", provenance["sourceFiles"]["lib/migrationExport.ts"])
    manifest, entries = parts()
    staging = tmp_path / "staging"
    staging.mkdir()
    for name, content in entries.items():
        target = staging / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (tmp_path / "metadata.json").write_bytes(object_bytes(manifest))
    if snapshot is not None and job is not None:
        tools = snapshot[snapshot.index("export function runTool("):snapshot.index("\nasync function toolOutput(")]
        start = snapshot.index("    const manifest = {")
        close_marker = "finally { await encrypted.close(); }"
        producer = snapshot[start:snapshot.index(close_marker, start) + len(close_marker)]
        id_expression = job[job.index("  const id = ") + len("  const id = "):job.index(", directory = path.join(exports, id);")]
    else:
        tools = (fixture / "run-tool.ts").read_text()
        producer = (fixture / "manifest-encryption.ts").read_text()
        id_expression = (fixture / "export-id.ts").read_text()
    script = tmp_path / "actual-producer.ts"
    script.write_text(
        """import fs from "node:fs/promises";
import path from "node:path";
import {createCipheriv,createHash,randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
class MigrationExportError extends Error {}
"""
        + tools
        + """
const directory=process.argv[2],staging=path.join(directory,'staging');
const supplied=JSON.parse(await fs.readFile(path.join(directory,'metadata.json'),'utf8'));
const source=supplied.source,point={snapshot:supplied.snapshot.snapshot,transactions:supplied.snapshot.transactions,captured_at:supplied.snapshot.captured_at};
const sequenceBefore=supplied.snapshot.sequences,users=supplied.users,tableManifest=supplied.tables;
const dumpFile=supplied.database,tocFile=supplied.database.toc;
const inventory={roots:supplied.originals.roots,files:supplied.originals.files.map(file=>({...file,path:file.path.slice(6)}))};
const finalConfiguration={keyFingerprint:supplied.sourceEncryption.keyFingerprintSha256},references=new Set(['one']);
const exportId="""
        + id_expression
        + """;
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const encryptionKey=Buffer.alloc(32,'s');
const MIGRATION_MAGIC=Buffer.from('ALCORMX1');
const progress=async(stage)=>{};
"""
        + producer
        + "\nprocess.stdout.write(exportId);\n"
    )
    result = subprocess.run(
        ["node", "--experimental-strip-types", str(script), str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    assert result.stdout.startswith("mex_") and len(result.stdout) == 36
    bundle = tmp_path / "bundle.partial"
    checked = verify(bundle, KEY)
    assert checked["exportId"] == result.stdout and checked["state"] == "verified_not_applied"


def test_bsdtar_zero_compressed_padding_exact_limit_is_not_another_stream(tmp_path):
    manifest, entries = parts()
    compressed = gzip.compress(tar_bytes(manifest, entries))
    for amount in (0, 10240):
        path, key, _ = write_bundle(
            tmp_path, manifest=manifest, entries=entries, plaintext=compressed + b"\0" * amount
        )
        assert verify(path, key)["state"] == "verified_not_applied"
    for tail in (b"\0" * 10241, b"\0" * 512 + b"x" + b"\0" * 511, gzip.compress(b"other stream")):
        path, key, _ = write_bundle(tmp_path, manifest=manifest, entries=entries, plaintext=compressed + tail)
        assert rejected(path, key) == "gzip_trailing"


def test_opaque_binary_pax_xattr_is_not_applied_but_effective_path_must_be_utf8(tmp_path):
    import tarfile

    for dangerous in (False, True):
        manifest, entries = parts()
        members = []
        for name, raw in entries.items():
            item = tarfile.TarInfo(name)
            item.size = len(raw)
            if name == "database.dump":
                item.pax_headers = (
                    {"path": "database.\udc80dump"}
                    if dangerous
                    else {"SCHILY.xattr.user.vendor": "opaque-binary-\udc80-value"}
                )
            members.append((item, raw))
        path, key, _ = write_bundle(
            tmp_path, manifest=manifest, entries=entries, tar=tar_bytes(manifest, entries, members=members)
        )
        if dangerous:
            rejected(path, key)
        else:
            assert verify(path, key)["state"] == "verified_not_applied"
