"""Operator-private resource roots. HTTP never chooses a path or source DSN."""

import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from .source_authority import definition_hash
from .source_snapshot import SourceDefinition, SourceMismatch, canonical, sha


class ResourceSourceError(ValueError):
    pass


def directory_identity(path):
    if not path.is_absolute():
        raise ResourceSourceError("source_root_identity_mismatch")
    for item in (path, *path.parents):
        if item.is_symlink():
            raise ResourceSourceError("source_root_identity_mismatch")
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid() or value.st_mode & 0o077:
        raise ResourceSourceError("source_root_identity_mismatch")
    return value.st_dev, value.st_ino


@dataclass(frozen=True)
class ResourceSource:
    alias: str
    schema_hash: str
    root: Path = field(repr=False)
    root_identity: tuple[int, int]
    source_definition: SourceDefinition | None = field(default=None, repr=False, compare=False)

    def require_access(self, owner=None):
        try:
            if self.source_definition is None:
                raise SourceMismatch("source_migration_window_unknown")
            self.source_definition.require_access(owner)
        except SourceMismatch as error:
            raise ResourceSourceError(str(error)) from None

    def check(self):
        self.require_access()
        if directory_identity(self.root) != self.root_identity:
            raise ResourceSourceError("source_root_identity_mismatch")

    def binding(self, definition):
        return sha(
            canonical(
                {
                    "sourceBinding": definition_hash(definition),
                    "resourceSchema": self.schema_hash,
                    "root": str(self.root),
                    "rootIdentity": self.root_identity,
                    "layout": "owner-sha256-fileid-v1",
                }
            )
        )

    def read_original(self, source_owner, file_id, size, digest):
        self.require_access(source_owner)
        self.check()
        if (
            not re.fullmatch(r"rlf_[a-f0-9]{32}", file_id)
            or not 1 <= size <= 52428800
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
        ):
            raise ResourceSourceError("source_original_metadata_invalid")
        root = owner = descriptor = None
        try:
            self.require_access(source_owner)
            root = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if (os.fstat(root).st_dev, os.fstat(root).st_ino) != self.root_identity:
                raise ResourceSourceError("source_root_identity_mismatch")
            self.require_access(source_owner)
            owner = os.open(
                sha(source_owner.encode()), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root
            )
            info = os.fstat(owner)
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ResourceSourceError("source_owner_directory_unsafe")
            self.require_access(source_owner)
            descriptor = os.open(file_id, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=owner)
            before = os.fstat(descriptor)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_uid != os.getuid()
                or before.st_mode & 0o077
                or before.st_size != size
            ):
                raise ResourceSourceError("source_original_unsafe")
            chunks = bytearray()
            while True:
                self.require_access(source_owner)
                chunk = os.read(descriptor, min(1024 * 1024, size + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
                if len(chunks) > size:
                    raise ResourceSourceError("source_original_changed")
            self.require_access(source_owner)
            after = os.fstat(descriptor)
            if (
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or len(chunks) != size
                or sha(chunks) != digest
            ):
                raise ResourceSourceError("source_original_changed")
            # Revalidate rooted pathname identity after reading an open file.
            self.require_access(source_owner)
            same = os.stat(file_id, dir_fd=owner, follow_symlinks=False)
            if (same.st_dev, same.st_ino) != (before.st_dev, before.st_ino):
                raise ResourceSourceError("source_original_changed")
            self.check()
            return bytes(chunks)
        except OSError:
            raise ResourceSourceError("source_original_missing_or_unsafe") from None
        finally:
            for fd in (descriptor, owner, root):
                if fd is not None:
                    os.close(fd)


def load_resources(settings, source_registry):
    path = settings.resource_import_registry_path
    if path is None:
        return {}
    try:
        info = path.lstat()
        directory_identity(path.parent)
        if (
            not path.is_absolute()
            or path.is_symlink()
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > 65536
        ):
            raise ValueError()
        value = json.loads(path.read_bytes())
        if (
            set(value) != {"version", "platformInstance", "resources"}
            or value["version"] != 1
            or value["platformInstance"] != str(settings.instance_id)
            or not 1 <= len(value["resources"]) <= 8
        ):
            raise ValueError()
        result = {}
        for item in value["resources"]:
            if (
                set(item) != {"sourceAlias", "resourceSchemaHash", "root", "rootIdentity", "layout"}
                or item["sourceAlias"] not in source_registry
                or item["sourceAlias"] in result
                or not re.fullmatch(r"[a-f0-9]{64}", item["resourceSchemaHash"])
                or item["layout"] != "owner-sha256-fileid-v1"
            ):
                raise ValueError()
            root = Path(item["root"])
            identity = tuple(item["rootIdentity"])
            if len(identity) != 2 or any(type(i) is not int or i < 0 for i in identity):
                raise ValueError()
            definition = ResourceSource(
                item["sourceAlias"],
                item["resourceSchemaHash"],
                root,
                identity,
                source_registry[item["sourceAlias"]],
            )
            # Expired or unknown windows must not probe the old source at startup.
            if definition.source_definition.window_status()["state"] == "active":
                definition.check()
            result[definition.alias] = definition
        return result
    except (OSError, ValueError, KeyError, TypeError):
        raise ResourceSourceError("资源来源登记权限、身份或结构不匹配") from None
