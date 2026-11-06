"""Explicit global operational read scope, separate from per-owner financial grants."""

import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path

from .source_authority import definition_hash
from .source_registry import load_registry
from .source_snapshot import SourceMismatch, canonical, sha

SCOPES = {"global-api-documents", "global-request-history"}


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def directory(path):
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise SourceMismatch("operational_source_root_unsafe")
    metadata = path.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mode & 0o022:
        raise SourceMismatch("operational_source_root_unsafe")
    return metadata.st_dev, metadata.st_ino


@dataclass(frozen=True)
class OperationalSource:
    alias: str
    owner: str
    scopes: tuple[str, ...]
    root: Path = field(repr=False)
    root_identity: tuple[int, int]
    log_identity: tuple[int, int] | None
    definition: object = field(repr=False)
    registration_path: Path = field(repr=False)
    registration_digest: str

    @property
    def physical(self):
        return sha(canonical(["global-operational-source/1", *self.root_identity]))

    @property
    def binding(self):
        return sha(
            canonical(
                [definition_hash(self.definition), self.owner, self.scopes, self.physical, self.log_identity]
            )
        )

    def require_access(self, scope):
        try:
            if sha(private_document(self.registration_path)) != self.registration_digest:
                raise SourceMismatch("operational_source_registration_changed")
        except (OSError, ValueError):
            raise SourceMismatch("operational_source_registration_changed") from None
        self.definition.require_access(self.owner)
        if scope not in self.scopes:
            raise SourceMismatch("operational_source_scope_not_registered")
        if directory(self.root) != self.root_identity:
            raise SourceMismatch("operational_source_root_changed")


def private_document(path):
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError()
    info, parent = path.lstat(), path.parent.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size > 65536
        or not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != os.getuid()
        or stat.S_IMODE(parent.st_mode) != 0o700
    ):
        raise ValueError()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        expected = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != expected:
            raise ValueError()
        raw = bytearray()
        while len(raw) <= 65536:
            chunk = os.read(descriptor, min(8192, 65537 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        after, linked = os.fstat(descriptor), path.lstat()
        if len(raw) > 65536 or any(
            (i.st_dev, i.st_ino, i.st_size, i.st_mtime_ns, i.st_ctime_ns) != expected for i in (after, linked)
        ):
            raise ValueError()
        return bytes(raw)
    finally:
        os.close(descriptor)


def load_operational_sources(settings):
    path = getattr(settings, "operational_source_registry_path", None)
    if path is None:
        return {}
    path = Path(path)
    try:
        raw = private_document(path)
        document = json.loads(raw, object_pairs_hook=unique)
        if (
            set(document) != {"version", "platformInstance", "sources"}
            or type(document["version"]) is not int
            or document["version"] != 1
            or document["platformInstance"] != str(settings.instance_id)
            or not isinstance(document["sources"], list)
            or not 1 <= len(document["sources"]) <= 4
        ):
            raise ValueError()
        definitions, result = load_registry(settings), {}
        for item in document["sources"]:
            if (
                not isinstance(item, dict)
                or set(item)
                != {
                    "sourceAlias",
                    "sourceOwner",
                    "scopes",
                    "root",
                    "rootIdentity",
                    "logIdentity",
                    "globalReadConfirmed",
                }
                or item["sourceAlias"] not in definitions
                or item["sourceAlias"] in result
                or item["globalReadConfirmed"] is not True
            ):
                raise ValueError()
            definition = definitions[item["sourceAlias"]]
            scopes = item["scopes"]
            if (
                item["sourceOwner"] not in definition.owners
                or not isinstance(scopes, list)
                or not scopes
                or len(set(scopes)) != len(scopes)
                or not set(scopes) <= SCOPES
            ):
                raise ValueError()

            def identity(value):
                if (
                    not isinstance(value, list)
                    or len(value) != 2
                    or any(type(i) is not int or i < 0 for i in value)
                ):
                    raise ValueError()
                return tuple(value)

            root = Path(item["root"])
            if not root.is_absolute():
                raise ValueError()
            log = identity(item["logIdentity"]) if item["logIdentity"] is not None else None
            if "global-request-history" in scopes and log is None:
                raise ValueError()
            result[definition.alias] = OperationalSource(
                definition.alias,
                item["sourceOwner"],
                tuple(sorted(scopes)),
                root,
                identity(item["rootIdentity"]),
                log,
                definition,
                path,
                sha(raw),
            )
        return result
    except (OSError, ValueError, TypeError, KeyError):
        raise SourceMismatch("operational_source_registration_invalid") from None
