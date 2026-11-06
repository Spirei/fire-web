"""Finite operator-private old data/attachments source; HTTP never chooses roots."""

import base64
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import HTTPException

from .admin_attachments import LIMIT, encoded, relpath
from .source_window import parse_window, window_state


class AttachmentSourceError(ValueError):
    pass


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def load_sources(settings):
    path = getattr(settings, "attachment_import_registry_path", None)
    if path is None:
        return {}
    path = Path(path)
    try:
        for parent in (path, *path.parents):
            if parent.is_symlink():
                raise ValueError()
        info = path.lstat()
        parent = path.parent.lstat()
        if (
            not path.is_absolute()
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != 0o700
            or info.st_size > 65536
        ):
            raise ValueError()
        value = json.loads(path.read_bytes(), object_pairs_hook=unique)
        if (
            set(value) != {"version", "platformInstance", "sources"}
            or type(value["version"]) is not int
            or value["version"] != 1
            or value["platformInstance"] != str(settings.instance_id)
            or not isinstance(value["sources"], list)
            or not 1 <= len(value["sources"]) <= 4
        ):
            raise ValueError()
        sources = {}
        for item in value["sources"]:
            if set(item) != {
                "alias",
                "scope",
                "layout",
                "root",
                "rootIdentity",
                "expectedUid",
                "migrationWindow",
                "maxEntries",
                "maxBytes",
                "maxDepth",
            }:
                raise ValueError()
            alias = item["alias"]
            root = Path(item["root"])
            identity = item["rootIdentity"]
            if (
                not re.fullmatch("[a-z0-9][a-z0-9_-]{2,63}", alias)
                or alias in sources
                or item["scope"] != "admin_shared_attachments"
                or item["layout"] != "fire-web-data-attachments-v1"
                or not root.is_absolute()
                or root.name != "attachments"
                or root.parent.name != "data"
                or not isinstance(identity, list)
                or len(identity) != 2
                or any(type(v) is not int or v < 0 for v in identity)
                or type(item["expectedUid"]) is not int
                or item["expectedUid"] < 0
            ):
                raise ValueError()
            for key, minimum, maximum in (
                ("maxEntries", 1, 100000),
                ("maxBytes", 0, 8 * 1024**3),
                ("maxDepth", 1, 128),
            ):
                if type(item[key]) is not int or not minimum <= item[key] <= maximum:
                    raise ValueError()
            definition = hashlib.sha256(
                encoded(
                    {
                        k: v
                        for k, v in item.items()
                        if k not in {"migrationWindow", "maxEntries", "maxBytes", "maxDepth"}
                    }
                )
            ).hexdigest()
            binding = hashlib.sha256(
                encoded({"scope": item["scope"], "layout": item["layout"], "rootIdentity": identity})
            ).hexdigest()
            sources[alias] = AttachmentSource(
                settings,
                alias,
                root,
                tuple(identity),
                item["expectedUid"],
                binding,
                definition,
                parse_window(item["migrationWindow"]),
                item["maxEntries"],
                item["maxBytes"],
                item["maxDepth"],
            )
        after = path.lstat()
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ValueError()
        return sources
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        raise AttachmentSourceError("attachment_source_registry_unavailable") from None


@dataclass(frozen=True)
class AttachmentSource:
    settings: object = field(repr=False)
    alias: str
    root: Path = field(repr=False)
    identity: tuple[int, int] = field(repr=False)
    uid: int
    binding: str
    definition: str
    window: object = field(repr=False)
    max_entries: int
    max_bytes: int
    max_depth: int

    def status(self):
        try:
            current = load_sources(self.settings).get(self.alias)
            if not current or current.definition != self.definition:
                raise AttachmentSourceError()
            return {
                **(current.window.document() if current.window else {}),
                "state": window_state(current.window),
            }
        except AttachmentSourceError:
            return {"state": "unavailable"}

    def require(self):
        current = load_sources(self.settings).get(self.alias)
        if not current or current.definition != self.definition:
            raise AttachmentSourceError("attachment_source_registry_changed")
        state = window_state(current.window)
        if state != "active":
            raise AttachmentSourceError("source_migration_window_" + state)
        return current

    def open_root(self):
        self.require()
        try:
            for path in (self.root, *self.root.parents):
                if path.is_symlink():
                    raise OSError()
            fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != self.identity or info.st_uid != self.uid or info.st_mode & 0o022:
                os.close(fd)
                raise OSError()
            return fd
        except OSError:
            raise AttachmentSourceError("attachment_source_root_identity_mismatch") from None


def proof(info):
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


class SourceScan:
    def __init__(self, source):
        self.source = source
        self.items = []
        self.blockers = []
        self.used = 0
        self.proofs = {}

    def walk(self):
        root = self.source.open_root()
        try:
            yield from self.directory(root, "", 0)
        finally:
            os.close(root)

    def directory(self, fd, path, depth):
        current = self.source.require()
        before = os.fstat(fd)
        self.proofs[path] = proof(before)
        try:
            names = sorted(os.listdir(fd))
        except OSError:
            self.blockers.append({"path": path, "reason": "source_directory_unreadable"})
            return
        for name in names:
            current = self.source.require()
            if len(self.items) >= current.max_entries:
                self.blockers.append(
                    {"path": path, "reason": "source_entry_budget_exceeded", "remainingCount": None}
                )
                return
            child = path + "/" + name if path else name
            item = {
                "path": child,
                "kind": "unknown",
                "size": None,
                "sha256": None,
                "captureState": "blocked",
                "reason": "source_entry_unverified",
            }
            try:
                child.encode("utf-8")
                if relpath(child) != child:
                    raise ValueError()
            except (ValueError, UnicodeError, HTTPException):
                item["path"] = child.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace")
                item["pathBytesBase64"] = base64.b64encode(os.fsencode(child)).decode()
                item["reason"] = "source_path_not_representable"
                self.items.append(item)
                yield item, None
                continue
            self.items.append(item)
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                self.proofs[child] = proof(info)
                item["sourceMtimeNs"] = info.st_mtime_ns
                if info.st_dev != self.source.identity[0]:
                    raise AttachmentSourceError("source_cross_filesystem_unregistered")
                if info.st_uid != self.source.uid or info.st_mode & 0o022:
                    raise AttachmentSourceError("source_entry_permissions_unverified")
                if stat.S_ISDIR(info.st_mode):
                    item.update(kind="directory", captureState="ready", reason=None)
                    yield item, None
                    if depth + 1 >= current.max_depth:
                        item.update(captureState="blocked", reason="source_depth_budget_exceeded")
                        continue
                    childfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        if proof(os.fstat(childfd)) != proof(info):
                            raise AttachmentSourceError("source_directory_changed")
                        yield from self.directory(childfd, child, depth + 1)
                    finally:
                        os.close(childfd)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    item.update(kind="file", size=info.st_size)
                    if info.st_size > LIMIT:
                        raise AttachmentSourceError("source_file_exceeds_50MiB")
                    if self.used + info.st_size > current.max_bytes:
                        raise AttachmentSourceError("source_byte_budget_exceeded")
                    self.source.require()
                    file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        if proof(os.fstat(file)) != proof(info):
                            raise AttachmentSourceError("source_file_changed")
                        raw = bytearray()
                        while True:
                            self.source.require()
                            part = os.read(file, min(1048576, LIMIT + 1 - len(raw)))
                            if not part:
                                break
                            raw.extend(part)
                            if len(raw) > info.st_size:
                                raise AttachmentSourceError("source_file_changed")
                        if (
                            len(raw) != info.st_size
                            or proof(os.fstat(file)) != proof(info)
                            or proof(os.stat(name, dir_fd=fd, follow_symlinks=False)) != proof(info)
                        ):
                            raise AttachmentSourceError("source_file_changed")
                    finally:
                        os.close(file)
                    self.used += len(raw)
                    item.update(sha256=hashlib.sha256(raw).hexdigest(), captureState="ready", reason=None)
                    yield item, bytes(raw)
                else:
                    raise AttachmentSourceError("source_link_or_special_file_not_allowed")
            except (OSError, AttachmentSourceError) as error:
                item.update(
                    captureState="blocked",
                    reason=str(error)
                    if isinstance(error, AttachmentSourceError)
                    else "source_entry_missing_or_unreadable",
                )
                yield item, None
        if proof(os.fstat(fd)) != proof(before):
            self.blockers.append({"path": path, "reason": "source_directory_membership_changed"})

    def finish(self):
        try:
            root = self.source.open_root()
            try:
                for item in self.items:
                    self.source.require()
                    if item["captureState"] != "ready":
                        continue
                    fd = os.dup(root)
                    try:
                        parts = item["path"].split("/")
                        for part in parts[:-1]:
                            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                            os.close(fd)
                            fd = child
                        actual = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                        if proof(actual) != self.proofs[item["path"]]:
                            raise OSError()
                    except OSError:
                        item.update(captureState="blocked", reason="source_entry_changed_after_read")
                    finally:
                        os.close(fd)
                if proof(os.fstat(root)) != self.proofs.get(""):
                    self.blockers.append({"path": "", "reason": "source_root_membership_changed"})
            finally:
                os.close(root)
        except AttachmentSourceError as error:
            self.blockers.append({"path": "", "reason": str(error)})
            for item in self.items:
                if item["captureState"] == "ready":
                    item.update(captureState="blocked", reason="source_final_verification_unavailable")
