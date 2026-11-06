"""Private file indexes and bounded, verified materialization for format 2."""

import hashlib
import os
import re
import stat
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path

from cryptography.fernet import Fernet

from .backup_stream_archive import Limits, validate_archive
from .backup_stream_codec import CHUNK, StreamFailure


def existing_directory(path):
    if path is None:
        raise StreamFailure("备份存储尚未配置")
    path = Path(path)
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise StreamFailure("私有目录路径不能包含符号链接")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise StreamFailure("私有目录权限无效")
    return path


def existing_key(settings):
    root = existing_directory(settings.backup_secret_dir)
    descriptor = os.open(root / "backup.key", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_nlink != 1
            or info.st_size > 128
        ):
            raise StreamFailure("备份密钥身份或权限无效")
        key = stream.read(129)
        Fernet(key)
        return key


def limits_for(settings):
    return Limits(max_bytes=settings.backup_stream_max_bytes, max_objects=settings.backup_stream_max_objects)


def fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


class HashedRead:
    def __init__(self, source):
        self.source = source
        self.hasher = hashlib.sha256()
        self.total = 0

    def read(self, size):
        if not 0 <= size <= 4 * CHUNK + 16:
            raise StreamFailure("备份密文必须分块读取")
        raw = self.source.read(size)
        self.hasher.update(raw)
        self.total += len(raw)
        return raw


@contextmanager
def open_archive(settings, row):
    root = existing_directory(settings.backup_dir)
    limits = limits_for(settings)
    size = row["bytes"]
    if type(size) is not int or not 1 <= size <= limits.encoded_max + limits.encoded_max // 1024 + 65536:
        raise StreamFailure("加密备份大小超过预算")
    descriptor = os.open(root / (str(row["id"]) + ".enc"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        before = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != os.getuid()
            or before.st_mode & 0o077
            or before.st_size != size
        ):
            raise StreamFailure("加密备份身份或大小无效")
        hashed = HashedRead(source)
        yield hashed, before
        if (
            hashed.total != size
            or hashed.hasher.hexdigest() != row["sha256"]
            or fingerprint(before) != fingerprint(os.fstat(source.fileno()))
        ):
            raise StreamFailure("加密备份文件校验失败或读取期间发生变化")


def validate_schema(settings, manifest):
    # Same prefix/identity rule as the existing v1 reader; format 2 changes IO,
    # not the authority or the schema compatibility promise.
    expected = {
        p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in settings.migration_dir.glob("[0-9]*.sql")
    }
    archived = manifest.get("schema")
    if (
        not isinstance(archived, dict)
        or "0006_backups.sql" not in archived
        or sorted(archived) != sorted(expected)[: len(archived)]
        or any(expected.get(name) != sha for name, sha in archived.items())
    ):
        raise StreamFailure("备份结构与当前版本不兼容")
    tables = manifest.get("tables")
    if not isinstance(tables, dict) or any(
        not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
        or not isinstance(info, dict)
        or set(info) != {"rows", "sha256"}
        or type(info["rows"]) is not int
        or info["rows"] < 0
        or not isinstance(info["sha256"], str)
        or not re.fullmatch("[0-9a-f]{64}", info["sha256"])
        for name, info in tables.items()
    ):
        raise StreamFailure("备份逐表校验信息无效")


class LoadedBackup(Mapping):
    def __init__(self, settings, row, manifest, secrets, source_fingerprint):
        self.settings = settings
        self.row = dict(row)
        self.manifest = manifest
        self.secrets = secrets
        self.source_fingerprint = source_fingerprint

    def __iter__(self):
        return iter(self.manifest["files"])

    def __len__(self):
        return len(self.manifest["files"])

    def __contains__(self, name):
        return name in self.manifest["files"]

    def __getitem__(self, name):
        if name in self.secrets:
            return self.secrets[name]
        # Existing small-file inspection tests remain compatible; production
        # restore materializes once rather than replaying for each object.
        if name not in self.manifest["files"]:
            raise KeyError(name)
        if self.manifest["files"][name]["bytes"] > 8 * CHUNK:
            raise StreamFailure("大备份文件必须使用流式恢复")
        import io

        target = io.BytesIO()

        @contextmanager
        def sink(entry, info):
            yield target if entry == name else None

        manifest, _secrets, _fingerprint = read_archive(self.settings, self.row, sink_factory=sink)
        if manifest != self.manifest:
            raise StreamFailure("备份在读取期间发生变化")
        return target.getvalue()

    def materialize(self, directory, cancelled=None):
        directory = existing_directory(directory)

        @contextmanager
        def sink(name, info):
            prefix, filename = name.split("/", 1) if "/" in name else ("", name)
            parent = directory / prefix if prefix else directory
            if prefix:
                parent.mkdir(mode=0o700, exist_ok=True)
                existing_directory(parent)
            descriptor = os.open(
                parent / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
            with os.fdopen(descriptor, "wb") as stream:
                yield stream
                stream.flush()
                os.fsync(stream.fileno())

        manifest, secrets, _fingerprint = read_archive(
            self.settings, self.row, sink_factory=sink, cancelled=cancelled
        )
        if manifest != self.manifest or secrets != self.secrets:
            raise StreamFailure("备份在恢复准备期间发生变化")
        return DiskEntries(directory, manifest, secrets)

    def open_download(self):
        root = existing_directory(self.settings.backup_dir)
        descriptor = os.open(
            root / (str(self.row["id"]) + ".enc"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        )
        source = os.fdopen(descriptor, "rb")
        if fingerprint(os.fstat(source.fileno())) != self.source_fingerprint:
            source.close()
            raise StreamFailure("备份在下载前发生变化")
        return source


class DiskEntries(Mapping):
    def __init__(self, directory, manifest, secrets):
        self.directory = directory
        self.manifest = manifest
        self.secrets = secrets

    def __iter__(self):
        return iter(self.manifest["files"])

    def __len__(self):
        return len(self.manifest["files"])

    def __contains__(self, name):
        return name in self.manifest["files"]

    def __getitem__(self, name):
        if name not in self.manifest["files"]:
            raise KeyError(name)
        if name not in self.secrets:
            raise StreamFailure("恢复大文件必须流式移动")
        return self.secrets[name]

    def copy_to(self, name, target, cancelled=None):
        if name not in self.manifest["files"]:
            raise StreamFailure("恢复条目不存在")
        source = self.directory / name
        # The staging directory is on the recovery filesystem by construction.
        # Database dump is the only copy to a potentially separate pg-tool temp.
        if name != "database.dump":
            os.replace(source, target)
        else:
            with open(source, "rb") as stream:
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, "wb") as output:
                    while raw := stream.read(CHUNK):
                        if cancelled is not None and cancelled.is_set():
                            raise StreamFailure("恢复已取消")
                        output.write(raw)
                    output.flush()
                    os.fsync(output.fileno())
        descriptor = os.open(Path(target).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def read_archive(settings, row, *, sink_factory=None, cancelled=None):
    try:
        key = existing_key(settings)
        with open_archive(settings, row) as (source, before):
            manifest, secrets = validate_archive(
                source,
                key,
                str(row["id"]),
                str(row["source_instance"]),
                limits_for(settings),
                sink_factory=sink_factory,
                cancelled=cancelled,
            )
            validate_schema(settings, manifest)
        return manifest, secrets, fingerprint(before)
    except (OSError, ValueError) as exc:
        raise StreamFailure("备份存储或密钥无法安全读取") from exc


def load_archive(settings, row):
    manifest, secrets, source_fingerprint = read_archive(settings, row)
    return manifest, LoadedBackup(settings, row, manifest, secrets, source_fingerprint)
