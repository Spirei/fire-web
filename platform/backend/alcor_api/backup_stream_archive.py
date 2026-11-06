"""Bounded tar archive producers/validators over the authenticated v2 codec."""

import hashlib
import io
import json
import os
import re
import stat
import tarfile
from contextlib import contextmanager
from dataclasses import dataclass

from .backup_stream_codec import CHUNK, DecryptReader, EncryptWriter, StreamFailure, canonical


@dataclass(frozen=True)
class Limits:
    max_bytes: int = 2 * 1024**3
    max_objects: int = 10000
    manifest_bytes: int = 16 * 1024**2

    @property
    def encoded_max(self):
        return self.max_bytes + self.max_objects * 1024 + 16 * 1024**2


DEFAULT_LIMITS = Limits()


def allowed_name(name):
    return isinstance(name, str) and (
        name
        in {"database.dump", "secrets/connections.key", "secrets/bootstrap.enc", "secrets/fx-providers.key"}
        or re.fullmatch(r"(?:files|resource-media)/[0-9a-f]{64}", name)
        or re.fullmatch(r"app-packages/[0-9a-f]{32}", name)
        or re.fullmatch(r"profile-media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", name)
        or (
            name.startswith("assets/")
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name[7:])
            and ".." not in name[7:]
        )
    )


def checked_source(source, size):
    try:
        info = os.fstat(source.fileno())
    except (AttributeError, io.UnsupportedOperation):
        return None
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or info.st_size != size
    ):
        raise StreamFailure("备份原文件身份、权限或大小无效")
    return info


class VerifiedSource:
    def __init__(self, source, size, sha, cancelled=None):
        self.source = source
        self.size = size
        self.sha = sha
        self.total = 0
        self.hasher = hashlib.sha256()
        self.cancelled = cancelled
        self.before = checked_source(source, size)

    def read(self, size):
        if size < 0 or size > CHUNK:
            raise StreamFailure("原文件必须分块读取")
        if self.cancelled is not None and self.cancelled.is_set():
            raise StreamFailure("备份已取消")
        raw = self.source.read(size)
        self.total += len(raw)
        self.hasher.update(raw)
        if self.total > self.size:
            raise StreamFailure("原文件读取超过登记大小")
        return raw

    def finish(self):
        if self.source.read(1) or self.total != self.size or self.hasher.hexdigest() != self.sha:
            raise StreamFailure("备份原文件摘要不符")
        if self.before is not None:
            after = checked_source(self.source, self.size)
            if (self.before.st_size, self.before.st_mtime_ns, self.before.st_ctime_ns) != (
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ):
                raise StreamFailure("备份期间原文件发生变化")


@dataclass(frozen=True)
class Blob:
    name: str
    size: int
    sha256: str
    opener: object

    @staticmethod
    def memory(name, raw):
        return Blob(name, len(raw), hashlib.sha256(raw).hexdigest(), lambda: io.BytesIO(raw))

    @staticmethod
    def file(name, path, size, sha):
        def opener():
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            return os.fdopen(descriptor, "rb")

        return Blob(name, size, sha, opener)


def parse_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def info_ok(info):
    return (
        isinstance(info, dict)
        and set(info) == {"bytes", "sha256"}
        and type(info["bytes"]) is int
        and info["bytes"] >= 0
        and isinstance(info["sha256"], str)
        and re.fullmatch("[0-9a-f]{64}", info["sha256"])
    )


def manifest_index(manifest, limits, backup_id, source_instance):
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != 2
        or manifest.get("backup_id") != backup_id
        or manifest.get("instance_id") != source_instance
    ):
        raise StreamFailure("备份清单身份无效")
    entries = manifest.get("files")
    if (
        not isinstance(entries, dict)
        or not 2 <= len(entries) <= limits.max_objects
        or not {"database.dump", "secrets/connections.key"} <= set(entries)
    ):
        raise StreamFailure("备份清单对象数量无效")
    if any(not allowed_name(n) or not info_ok(v) for n, v in entries.items()):
        raise StreamFailure("备份清单路径或原文件信息无效")
    if sum(v["bytes"] for v in entries.values()) + len(canonical(manifest)) > limits.max_bytes:
        raise StreamFailure("备份超过容量预算")
    return entries


def pack_archive(target, wrapping_key, manifest, blobs, limits=DEFAULT_LIMITS, cancelled=None):
    blobs = list(blobs)
    if len(blobs) > limits.max_objects or len({blob.name for blob in blobs}) != len(blobs):
        raise StreamFailure("备份对象数量或名称无效")
    value = {
        **manifest,
        "format": 2,
        "files": {blob.name: {"bytes": blob.size, "sha256": blob.sha256} for blob in blobs},
    }
    manifest_index(value, limits, value["backup_id"], value["instance_id"])
    raw_manifest = canonical(value)
    if len(raw_manifest) > limits.manifest_bytes:
        raise StreamFailure("备份清单超过预算")
    encoder = EncryptWriter(
        target, wrapping_key, value["backup_id"], value["instance_id"], maximum=limits.encoded_max
    )
    with tarfile.open(fileobj=encoder, mode="w|gz") as archive:
        item = tarfile.TarInfo("manifest.json")
        item.mode = 0o600
        item.size = len(raw_manifest)
        archive.addfile(item, io.BytesIO(raw_manifest))
        for blob in blobs:
            if cancelled is not None and cancelled.is_set():
                raise StreamFailure("备份已取消")
            item = tarfile.TarInfo(blob.name)
            item.mode = 0o600
            item.size = blob.size
            try:
                with blob.opener() as source:
                    verified = VerifiedSource(source, blob.size, blob.sha256, cancelled)
                    archive.addfile(item, verified)
                    verified.finish()
            except (OSError, StreamFailure):
                if blob.name.startswith("profile-media/"):
                    raise StreamFailure("个人资料文件缺失或不完整，无法完成可恢复备份") from None
                if blob.name.startswith("resource-media/"):
                    raise StreamFailure("资源库原文件缺失或不完整，无法完成可恢复备份") from None
                raise
    count, sha = encoder.finish()
    return value, count, sha


def bounded_member(source, size, limit):
    if not 0 <= size <= limit:
        raise StreamFailure("备份元信息超过预算")
    parts = []
    left = size
    while left:
        raw = source.read(min(left, CHUNK))
        if not raw:
            raise StreamFailure("备份内容不完整")
        parts.append(raw)
        left -= len(raw)
    return b"".join(parts)


@contextmanager
def null_sink():
    yield None


def bounded_tarinfo(maximum_headers):
    count = 0
    consecutive = 0

    class BoundedTarInfo(tarfile.TarInfo):
        def _proc_member(self, archive):
            nonlocal count, consecutive
            count += 1
            if count > maximum_headers:
                raise StreamFailure("备份归档头数量超过预算")
            auxiliary = self.type in (
                tarfile.GNUTYPE_LONGNAME,
                tarfile.GNUTYPE_LONGLINK,
                tarfile.XHDTYPE,
                tarfile.XGLTYPE,
                tarfile.SOLARIS_XHDTYPE,
            )
            consecutive = consecutive + 1 if auxiliary else 0
            if (auxiliary and self.size > 65536) or consecutive > 32:
                raise StreamFailure("备份扩展归档头超过预算")
            if self.type == tarfile.GNUTYPE_SPARSE:
                raise StreamFailure("备份不接收稀疏归档")
            return super()._proc_member(archive)

        def _proc_gnusparse_00(self, *args, **kwargs):
            raise StreamFailure("备份不接收稀疏归档")

        _proc_gnusparse_01 = _proc_gnusparse_00
        _proc_gnusparse_10 = _proc_gnusparse_00

    return BoundedTarInfo


def validate_archive(
    source,
    wrapping_key,
    backup_id,
    source_instance,
    limits=DEFAULT_LIMITS,
    *,
    sink_factory=None,
    cancelled=None,
):
    decoder = DecryptReader(source, wrapping_key, backup_id, source_instance, maximum=limits.encoded_max)
    seen = set()
    secrets = {}
    manifest = None
    expected = None
    try:
        with tarfile.open(
            fileobj=decoder, mode="r|gz", tarinfo=bounded_tarinfo(limits.max_objects * 2 + 16)
        ) as archive:
            for item in archive:
                if cancelled is not None and cancelled.is_set():
                    raise StreamFailure("备份已取消")
                if not item.isfile() or item.name in seen or item.size < 0 or len(seen) > limits.max_objects:
                    raise StreamFailure("备份归档条目无效")
                seen.add(item.name)
                payload = archive.extractfile(item)
                if manifest is None:
                    if item.name != "manifest.json":
                        raise StreamFailure("备份缺少首项清单")
                    raw = bounded_member(payload, item.size, limits.manifest_bytes)
                    manifest = json.loads(raw, object_pairs_hook=parse_object)
                    expected = manifest_index(manifest, limits, backup_id, source_instance)
                    continue
                if item.name not in expected or item.size != expected[item.name]["bytes"]:
                    raise StreamFailure("备份条目与清单不符")
                hashed = hashlib.sha256()
                left = item.size
                small = []
                if item.name.startswith("secrets/") and item.size > 65536:
                    raise StreamFailure("备份秘密条目超过预算")
                with sink_factory(item.name, expected[item.name]) if sink_factory else null_sink() as sink:
                    while left:
                        if cancelled is not None and cancelled.is_set():
                            raise StreamFailure("备份已取消")
                        raw = payload.read(min(left, CHUNK))
                        if not raw:
                            raise StreamFailure("备份内容不完整")
                        left -= len(raw)
                        hashed.update(raw)
                        if sink is not None:
                            written = sink.write(raw)
                            if written is not None and written != len(raw):
                                raise StreamFailure("恢复存储未完整写入")
                        if item.name.startswith("secrets/"):
                            small.append(raw)
                if hashed.hexdigest() != expected[item.name]["sha256"]:
                    raise StreamFailure("备份内容摘要不符")
                if item.name.startswith("secrets/"):
                    secrets[item.name] = b"".join(small)
        decoder.finish()
        if manifest is None or seen - {"manifest.json"} != set(expected):
            raise StreamFailure("备份清单与实际条目不符")
    except (tarfile.TarError, ValueError, TypeError, KeyError, EOFError, OSError):
        raise StreamFailure("备份归档无法验证") from None
    return manifest, secrets
