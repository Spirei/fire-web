"""Offline ALCORMX1 integrity verification. No extraction, database or network actions."""

import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import unicodedata
import zlib
from dataclasses import dataclass
from decimal import Decimal, DecimalException
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .backup_stream_archive import bounded_tarinfo, parse_object
from .backup_stream_codec import StreamFailure

MAGIC = b"ALCORMX1"
CHUNK = 1024 * 1024
ROOTS = (
    "public",
    "resource-default",
    "data/attachments",
    "data/resource-library",
    "data/assistant-attachments",
)


class VerificationFailure(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__("Unified export rejected: " + code)


@dataclass(frozen=True)
class Limits:
    max_bundle_bytes: int = 2 * 1024**3
    max_total_bytes: int = 2 * 1024**3
    max_member_bytes: int = 2 * 1024**3
    max_members: int = 100000
    max_manifest_bytes: int = 16 * 1024**2
    max_jsonl_line_bytes: int = 8 * 1024**2
    max_rows: int = 10000000
    max_header_bytes: int = 16384
    max_expansion_ratio: int = 2048
    min_free_bytes: int = 64 * 1024**2
    temporary_directory: Path | None = None


DEFAULT_LIMITS = Limits()


def reject(code):
    raise VerificationFailure(code)


def strict_json(raw, *, row=False):
    def bad(_):
        reject("invalid_json")

    return json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=parse_object,
        parse_float=Decimal,
        parse_int=Decimal if row else int,
        parse_constant=bad,
    )


def natural(value, maximum):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value) or len(value) > 30:
        reject("invalid_count")
    number = int(value)
    if number > maximum:
        reject("budget_exceeded")
    return number


def safe_name(name):
    if (
        not isinstance(name, str)
        or not name
        or len(name.encode("utf-8")) > 4096
        or name.startswith("/")
        or "\\" in name
        or ":" in name
        or any(part in ("", ".", "..") for part in name.split("/"))
        or any(unicodedata.category(char).startswith("C") for char in name)
    ):
        reject("unsafe_path")
    return unicodedata.normalize("NFC", name).casefold()


def file_info(item, limits):
    if not isinstance(item, dict):
        reject("invalid_manifest")
    name = item.get("path")
    safe_name(name)
    size = natural(item.get("bytes"), min(limits.max_member_bytes, limits.max_total_bytes))
    sha = item.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha):
        reject("invalid_digest")
    return name, {"bytes": size, "sha256": sha}


def manifest_index(manifest, header, limits):
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != "alcor-unified-migration"
        or type(manifest.get("formatVersion")) is not int
        or manifest.get("formatVersion") != 1
        or manifest.get("exportId") != header["exportId"]
    ):
        reject("manifest_identity")
    source, snapshot = manifest.get("source"), manifest.get("snapshot")
    if (
        not isinstance(source, dict)
        or source.get("backend") != "postgres"
        or source.get("driver") != "pg"
        or not isinstance(source.get("schema"), str)
        or not source["schema"]
        or not isinstance(snapshot, dict)
        or snapshot.get("isolation") != "repeatable-read-read-only"
        or snapshot.get("scope") != "all-non-system-database-schemas"
        or snapshot.get("restoreMode") != "isolated-quarantine-only"
        or snapshot.get("sequenceStability") != "unchanged-through-original-verification"
    ):
        reject("source_contract")

    def text_field(value):
        return (
            isinstance(value, str)
            and 0 < len(value.encode("utf-8")) <= 4096
            and not any(unicodedata.category(char).startswith("C") for char in value)
        )

    if any(
        not text_field(source.get(key))
        for key in (
            "origin",
            "appVersion",
            "buildSha",
            "database",
            "migrationId",
            "instanceId",
            "serverVersion",
        )
    ):
        reject("source_contract")
    origin = urlsplit(source["origin"])
    if (
        origin.scheme not in {"http", "https"}
        or not origin.hostname
        or origin.username
        or origin.password
        or origin.path
        or origin.query
        or origin.fragment
        or not re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+", source["appVersion"])
        or not (re.fullmatch(r"[a-f0-9]{40}", source["buildSha"]) or source["buildSha"] == "unknown")
        or not re.fullmatch(r"[a-f0-9]{64}", source["instanceId"])
        or not re.match(r"[1-9][0-9]*(?:\.[0-9]+)+", source["serverVersion"])
    ):
        reject("source_contract")
    users, domains = manifest.get("users"), manifest.get("domains")
    if (
        not text_field(manifest.get("createdAt"))
        or not isinstance(users, list)
        or not 1 <= len(users) <= limits.max_members
        or not isinstance(domains, list)
        or any(not text_field(domain) for domain in domains)
        or len(set(domains)) != len(domains)
    ):
        reject("manifest_metadata")
    user_ids = set()
    for user in users:
        if (
            not isinstance(user, dict)
            or not text_field(user.get("id"))
            or user["id"] in user_ids
            or user.get("uid") is not None
            and not text_field(user["uid"])
        ):
            reject("manifest_metadata")
        user_ids.add(user["id"])
    if (
        any(not text_field(snapshot.get(key)) for key in ("snapshot", "transactions", "captured_at"))
        or not isinstance(snapshot.get("sequences"), list)
        or len(snapshot["sequences"]) > limits.max_members
    ):
        reject("snapshot_contract")
    for sequence in snapshot["sequences"]:
        if (
            not isinstance(sequence, dict)
            or any(not text_field(sequence.get(key)) for key in ("schema", "name", "value"))
            or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)", sequence["value"])
            or type(sequence.get("is_called")) is not bool
        ):
            reject("snapshot_contract")
    omissions = manifest.get("omissions")
    expected_omissions = {
        "businessTables": [],
        "sourceEncryptionKey": "not-included-transfer-separately",
        "connectionConfiguration": "not-included",
        "clusterRolesAndTablespaces": "not-in-database-dump",
        "externalNetworkFetches": "none",
    }
    preservation, encryption = manifest.get("preservation"), manifest.get("sourceEncryption")
    if (
        not isinstance(omissions, dict)
        or any(omissions.get(k) != v for k, v in expected_omissions.items())
        or not isinstance(preservation, dict)
        or preservation.get("originalIdsAndExecutionStates") is not True
        or preservation.get("financialProjectionReplay") is not False
        or preservation.get("sourceWrites") is not False
        or preservation.get("unknowns") != "unchanged"
        or preservation.get("financialNumbers")
        != "native-pg-dump-and-server-json-lexemes-no-js-number-roundtrip"
        or not isinstance(encryption, dict)
        or encryption.get("keyIncluded") is not False
        or encryption.get("separateOriginalKeyRequired") is not True
        or encryption.get("format") != "enc:v1:aes-256-gcm"
        or not isinstance(encryption.get("keyFingerprintSha256"), str)
        or not re.fullmatch(r"[a-f0-9]{64}", encryption["keyFingerprintSha256"])
        or encryption.get("fingerprintInput") != "sha256(sha256(original-key-bytes))"
    ):
        reject("preservation_contract")
    tables, originals, database = manifest.get("tables"), manifest.get("originals"), manifest.get("database")
    if not isinstance(tables, list) or not isinstance(originals, dict) or not isinstance(database, dict):
        reject("invalid_manifest")
    files, roots = originals.get("files"), originals.get("roots")
    if (
        not isinstance(files, list)
        or len(tables) + len(files) + 4 > limits.max_members
        or not isinstance(roots, list)
        or len(roots) != len(ROOTS)
    ):
        reject("manifest_budget")
    declared_roots = {}
    for root in roots:
        if (
            not isinstance(root, dict)
            or root.get("path") not in ROOTS
            or root["path"] in declared_roots
            or type(root.get("present")) is not bool
        ):
            reject("original_roots")
        declared_roots[root["path"]] = root["present"]
    if not declared_roots.get("public"):
        reject("original_roots")
    index, folded, table_names = {}, set(), set()

    def add(item):
        name, info = file_info(item, limits)
        fold = safe_name(name)
        if name in {"manifest.json", "seal.json"} or fold in folded:
            reject("duplicate_path")
        folded.add(fold)
        index[name] = info
        return name, info

    if database.get("format") != "pg_dump-custom" or database.get("path") != "database.dump":
        reject("database_contract")
    add(database)
    toc = database.get("toc")
    if not isinstance(toc, dict) or toc.get("path") != "database.toc":
        reject("database_contract")
    add(toc)
    rows_total = 0
    for table in tables:
        if not isinstance(table, dict) or any(
            not isinstance(table.get(k), str) or not table[k] for k in ("schema", "name")
        ):
            reject("table_contract")
        if not text_field(table.get("domain")):
            reject("domain_contract")
        pair = (table["schema"], table["name"])
        # The manifest binds the table to its opaque sidecar. Filenames are not
        # a schema/name encoding; dots in either identifier must stay distinct.
        sidecar = table.get("path")
        if (pair in table_names or not isinstance(sidecar, str)
                or not re.fullmatch(r"tables/[a-f0-9]{64}\.jsonl", sidecar)
                or table.get("kind") not in ("r", "p", "m")):
            reject("table_contract")
        table_names.add(pair)
        if table.get("rowEncoding") != "postgres-row_to_json-text-utf8-lf":
            reject("table_contract")
        columns = table.get("columns")
        if not isinstance(columns, list) or len(columns) > 4096:
            reject("table_columns")
        seen_columns = set()
        for column in columns:
            if (
                not isinstance(column, dict)
                or not isinstance(column.get("name"), str)
                or not column["name"]
                or column["name"] in seen_columns
                or not isinstance(column.get("type"), str)
                or type(column.get("required")) is not bool
                or not isinstance(column.get("identity"), str)
                or not isinstance(column.get("generated"), str)
            ):
                reject("table_columns")
            seen_columns.add(column["name"])
        count = natural(table.get("rowCount"), limits.max_rows)
        rows_total += count
        if rows_total > limits.max_rows:
            reject("budget_exceeded")
        name, info = add(table)
        info["rows"] = count
        info["columns"] = seen_columns
    original_bytes = 0
    for original in files:
        name, info = add(original)
        if not any(
            present and name.startswith("files/" + path + "/") for path, present in declared_roots.items()
        ):
            reject("original_path")
        original_bytes += info["bytes"]
    if (
        natural(originals.get("count"), limits.max_members) != len(files)
        or natural(originals.get("bytes"), limits.max_total_bytes) != original_bytes
    ):
        reject("original_count")
    if set(domains) != {table.get("domain") for table in tables}:
        reject("domain_contract")
    natural(originals.get("registeredLocalReferences"), limits.max_members)
    total = sum(info["bytes"] for info in index.values())
    if total > limits.max_total_bytes:
        reject("budget_exceeded")
    directories = {"tables", "files"}
    for name in index:
        parts = name.split("/")
        directories.update("/".join(parts[:i]) for i in range(1, len(parts)))
    return index, directories, rows_total, len(files), original_bytes


def stamp(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def write_private(target, raw, limits):
    location = limits.temporary_directory or tempfile.gettempdir()
    if shutil.disk_usage(location).free < limits.min_free_bytes + len(raw):
        reject("temporary_space")
    if target.write(raw) != len(raw):
        reject("temporary_write")


def decompress(source, target, limits):
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    total = 0
    padding = 0

    def check_padding(block):
        nonlocal padding
        padding += len(block)
        if padding > 10240 or any(block):
            reject("gzip_trailing")

    maximum = limits.max_total_bytes + limits.max_members * 1024 + 2 * limits.max_manifest_bytes + 1024**2
    source.seek(0)
    compressed = os.fstat(source.fileno()).st_size
    while chunk := source.read(CHUNK):
        if decoder.eof:
            check_padding(chunk)
            continue
        while chunk:
            block = decoder.decompress(chunk, min(CHUNK, maximum - total + 1))
            total += len(block)
            if total > maximum or total > compressed * limits.max_expansion_ratio + 1024**2:
                reject("expanded_budget")
            write_private(target, block, limits)
            if decoder.eof:
                check_padding(decoder.unused_data)
                break
            chunk = decoder.unconsumed_tail
    if not decoder.eof:
        reject("gzip_incomplete")
    target.seek(0)


def read_small(stream, size, maximum):
    if size < 0 or size > maximum:
        reject("metadata_budget")
    raw = stream.read(size)
    if len(raw) != size:
        reject("member_incomplete")
    return raw


def check_tar(source, header, limits):
    seen, folds, directories = set(), set(), set()
    manifest, index = None, None
    seal = None
    total = 0
    end = 0
    header_class = bounded_tarinfo(limits.max_members * 3 + 32)

    class StrictInfo(header_class):
        def _proc_member(self, archive):
            if (
                self.size < 0
                or self.size > limits.max_member_bytes
                or self.type in (tarfile.LNKTYPE, tarfile.SYMTYPE)
            ):
                reject("unsafe_member")
            return super()._proc_member(archive)

    with tarfile.open(
        fileobj=source, mode="r:", tarinfo=StrictInfo, encoding="utf-8", errors="surrogateescape"
    ) as archive:
        for item in archive:
            if (
                len(seen) >= limits.max_members
                or not (item.isfile() or item.isdir())
                or item.sparse is not None
            ):
                reject("unsafe_member")
            if item.linkname or any("sparse" in key.lower() or key == "linkpath" for key in item.pax_headers):
                reject("unsafe_member")
            name = item.name.rstrip("/") if item.isdir() else item.name
            fold = safe_name(name)
            if name in seen or fold in folds:
                reject("duplicate_path")
            seen.add(name)
            folds.add(fold)
            end = item.offset_data + (item.size + 511) // 512 * 512
            if item.isdir():
                if index is None or name not in directories or item.size != 0:
                    reject("undeclared_directory")
                continue
            total += item.size
            if total > limits.max_total_bytes:
                reject("expanded_budget")
            payload = archive.extractfile(item)
            if manifest is None:
                if name != "manifest.json":
                    reject("manifest_order")
                raw = read_small(payload, item.size, limits.max_manifest_bytes)
                manifest = strict_json(raw)
                manifest_sha = hashlib.sha256(raw).hexdigest()
                index, directories, row_count, original_count, original_bytes = manifest_index(
                    manifest, header, limits
                )
                continue
            if seal is None:
                if name != "seal.json":
                    reject("seal_order")
                seal = strict_json(read_small(payload, item.size, 65536))
                if (
                    not isinstance(seal, dict)
                    or set(seal) != {"version", "algorithm", "manifestSha256", "fileCount"}
                    or type(seal.get("version")) is not int
                    or seal.get("version") != 1
                    or seal.get("algorithm") != "sha256"
                    or seal.get("manifestSha256") != manifest_sha
                    or natural(seal.get("fileCount"), limits.max_members) != len(index)
                ):
                    reject("seal_mismatch")
                continue
            if name not in index or item.size != index[name]["bytes"]:
                reject("undeclared_member")
            hashed = hashlib.sha256()
            if "rows" in index[name]:
                count = 0
                while line := payload.readline(limits.max_jsonl_line_bytes + 1):
                    if (
                        len(line) > limits.max_jsonl_line_bytes
                        or not line.endswith(b"\n")
                        or b"\r\n" == line[-2:]
                    ):
                        reject("jsonl_line")
                    row = strict_json(line[:-1], row=True)
                    if not isinstance(row, dict) or set(row) != index[name]["columns"]:
                        reject("jsonl_object")
                    count += 1
                    if count > index[name]["rows"]:
                        reject("row_count")
                    hashed.update(line)
                if count != index[name]["rows"]:
                    reject("row_count")
            else:
                left = item.size
                prefix = b""
                while left:
                    block = payload.read(min(CHUNK, left))
                    if not block:
                        reject("member_incomplete")
                    if len(prefix) < 5:
                        prefix += block[: 5 - len(prefix)]
                    left -= len(block)
                    hashed.update(block)
                if name == "database.dump" and prefix != b"PGDMP":
                    reject("dump_magic")
            if hashed.hexdigest() != index[name]["sha256"]:
                reject("member_digest")
    if (
        manifest is None
        or seal is None
        or {n for n in seen if n not in directories | {"manifest.json", "seal.json"}} != set(index)
    ):
        reject("missing_member")
    source.seek(end)
    remaining = os.fstat(source.fileno()).st_size - end
    if remaining < 1024 or remaining % 512:
        reject("tar_termination")
    while block := source.read(CHUNK):
        if any(block):
            reject("tar_trailing")
    return {
        "manifestSha256": manifest_sha,
        "tableCount": len(manifest["tables"]),
        "rowCount": str(row_count),
        "originalFileCount": original_count,
        "originalBytes": str(original_bytes),
        "verifiedContentBytes": str(total),
    }


def verify(bundlePath, keyBytes, limits=DEFAULT_LIMITS):
    """Authenticate a private temporary copy before inspecting any archive member."""
    if not isinstance(limits, Limits) or any(
        type(value) is not int or value <= 0
        for name, value in vars(limits).items()
        if name != "temporary_directory"
    ):
        reject("invalid_limits")
    if type(keyBytes) is not bytes or len(keyBytes) != 32:
        reject("invalid_key")
    try:
        path = Path(bundlePath)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            before = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_size > limits.max_bundle_bytes
                or before.st_size < 29
            ):
                reject("input_file")
            prefix = source.read(12)
            if prefix[:8] != MAGIC:
                reject("magic")
            size = int.from_bytes(prefix[8:], "big")
            if not 1 <= size <= limits.max_header_bytes or before.st_size < 12 + size + 16:
                reject("header_budget")
            raw_header = read_small(source, size, limits.max_header_bytes)
            header = strict_json(raw_header)
            fields = {"format", "version", "exportId", "cipher", "nonce", "keyDerivation", "payload"}
            if (
                not isinstance(header, dict)
                or set(header) != fields
                or header.get("format") != "alcor-unified-migration"
                or type(header.get("version")) is not int
                or header.get("version") != 1
                or header.get("cipher") != "AES-256-GCM"
                or header.get("keyDerivation") != "none-32-random-bytes"
                or header.get("payload") != "tar.gz"
                or not isinstance(header.get("exportId"), str)
                or not re.fullmatch(r"mex_[a-f0-9]{32}", header["exportId"])
                or not isinstance(header.get("nonce"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{16}", header["nonce"])
            ):
                reject("header_contract")
            nonce = base64.urlsafe_b64decode(header["nonce"])
            source.seek(-16, io.SEEK_END)
            tag = source.read(16)
            decryptor = Cipher(algorithms.AES(keyBytes), modes.GCM(nonce, tag)).decryptor()
            aad = prefix + raw_header
            decryptor.authenticate_additional_data(aad)
            hashed = hashlib.sha256(aad)
            source.seek(len(aad))
            left = before.st_size - len(aad) - 16
            with (
                tempfile.TemporaryFile(dir=limits.temporary_directory) as plaintext,
                tempfile.TemporaryFile(dir=limits.temporary_directory) as archive,
            ):
                while left:
                    block = source.read(min(left, CHUNK))
                    if not block:
                        reject("input_changed")
                    left -= len(block)
                    hashed.update(block)
                    write_private(plaintext, decryptor.update(block), limits)
                write_private(plaintext, decryptor.finalize(), limits)
                hashed.update(tag)
                if stamp(before) != stamp(os.fstat(source.fileno())) or stamp(before) != stamp(path.lstat()):
                    reject("input_changed")
                decompress(plaintext, archive, limits)
                result = check_tar(archive, header, limits)
            if stamp(before) != stamp(os.fstat(source.fileno())) or stamp(before) != stamp(path.lstat()):
                reject("input_changed")
            return {
                "state": "verified_not_applied",
                "format": "alcor-unified-migration",
                "version": 1,
                "exportId": header["exportId"],
                "bundleSha256": hashed.hexdigest(),
                "bundleBytes": str(before.st_size),
                **result,
                "sourceIdentity": "self_declared_not_authenticated",
                "sourceEncryptionKeyIncluded": False,
                "applied": False,
                "sqlExecuted": False,
            }
    except VerificationFailure:
        raise
    except InvalidTag:
        raise VerificationFailure("authentication_failed") from None
    except (
        OSError,
        DecimalException,
        ValueError,
        TypeError,
        KeyError,
        RecursionError,
        OverflowError,
        tarfile.TarError,
        zlib.error,
        StreamFailure,
    ):
        raise VerificationFailure("invalid_bundle") from None
