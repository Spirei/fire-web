"""Explicitly attested legacy font basenames under an operator-owned finite source root."""

import base64
import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path

from .font_codec import LIMIT
from .personal_fonts import PATTERN
from .source_authority import definition_hash
from .source_registry import load_registry
from .source_snapshot import SourceMismatch, canonical, sha


def directory(path):
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise SourceMismatch("font_source_root_unsafe")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
        raise SourceMismatch("font_source_root_unsafe")
    return info.st_dev, info.st_ino


@dataclass(frozen=True)
class FontRoot:
    alias: str
    path: Path = field(repr=False)
    identity: tuple[int, int]
    definition: object = field(repr=False)

    @property
    def physical(self):
        return sha(canonical(["legacy-font-root/1", *self.identity]))

    @property
    def binding(self):
        return sha(canonical([definition_hash(self.definition), str(self.path), self.physical]))


def roots(settings):
    path = settings.font_import_registry_path
    if path is None:
        return {}
    try:
        path = Path(path)
        info, parent = path.lstat(), path.parent.lstat()
        if (
            not path.is_absolute()
            or any(p.is_symlink() for p in (path, *path.parents))
            or not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > 65536
            or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) != 0o700
        ):
            raise ValueError()
        doc = json.loads(path.read_bytes())
        if (
            set(doc) != {"version", "platformInstance", "roots"}
            or doc["version"] != 1
            or doc["platformInstance"] != str(settings.instance_id)
            or not isinstance(doc["roots"], list)
            or not 1 <= len(doc["roots"]) <= 8
        ):
            raise ValueError()
        registry, result = load_registry(settings), {}
        for item in doc["roots"]:
            if (
                set(item) != {"sourceAlias", "root", "rootIdentity", "layout", "ownerEvidencePolicy"}
                or item["sourceAlias"] not in registry
                or item["sourceAlias"] in result
                or item["layout"] != "fire-web-custom-fonts-v1"
                or item["ownerEvidencePolicy"] != "admin-and-owner-attested"
                or not isinstance(item["rootIdentity"], list)
                or len(item["rootIdentity"]) != 2
                or any(type(i) is not int or i < 0 for i in item["rootIdentity"])
            ):
                raise ValueError()
            result[item["sourceAlias"]] = FontRoot(
                item["sourceAlias"],
                Path(item["root"]),
                tuple(item["rootIdentity"]),
                registry[item["sourceAlias"]],
            )
        return result
    except (OSError, ValueError, TypeError, KeyError):
        raise SourceMismatch("font_source_registration_invalid") from None


def registered(settings, permission, *, live):
    root = roots(settings).get(permission["source_alias"])
    if (
        not root
        or root.binding != permission["root_binding"]
        or root.physical != permission["root_identity"]
        or definition_hash(root.definition) != permission["binding_hash"]
    ):
        raise SourceMismatch("font_source_registration_changed")
    if live:
        root.definition.require_access(permission["source_owner"])
        if directory(root.path) != root.identity:
            raise SourceMismatch("font_source_root_identity_changed")
    return root


def read(settings, permission):
    # Only this strict pre-registered basename is accepted from HTTP. No nested
    # relative path, URL, arbitrary locator or UID-derived ownership is allowed.
    identifier = permission["original_id"]
    if not PATTERN.fullmatch(identifier):
        raise SourceMismatch("font_source_original_id_invalid")
    handles = []
    try:
        root = registered(settings, permission, live=True)
        parent = os.open(root.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        handles.append(parent)
        if (os.fstat(parent).st_dev, os.fstat(parent).st_ino) != root.identity:
            raise SourceMismatch("font_source_root_identity_changed")

        def one(name, limit, optional=False):
            registered(settings, permission, live=True)
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                if optional:
                    return None, None
                raise
            handles.append(fd)
            before = os.fstat(fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_mode & 0o022
                or not 0 <= before.st_size <= limit
            ):
                raise SourceMismatch("font_source_file_unsafe_or_too_large")
            raw = bytearray()
            while True:
                registered(settings, permission, live=True)
                part = os.read(fd, min(65536, limit + 1 - len(raw)))
                if not part:
                    break
                raw.extend(part)
                if len(raw) > limit:
                    raise SourceMismatch("font_source_file_changed")
            after = os.fstat(fd)
            same = os.stat(name, dir_fd=parent, follow_symlinks=False)
            fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if (
                fields(before) != fields(after)
                or fields(before) != fields(same)
                or len(raw) != before.st_size
            ):
                raise SourceMismatch("font_source_file_changed")
            registered(settings, permission, live=True)
            return bytes(raw), {
                "device": str(before.st_dev),
                "inode": str(before.st_ino),
                "mtimeNs": str(before.st_mtime_ns),
                "ctimeNs": str(before.st_ctime_ns),
            }

        raw, attrs = one(identifier, LIMIT)
        if len(raw) < 48 or sha(raw) != identifier.split("-")[-1].split(".")[0]:
            raise SourceMismatch("font_source_sha_or_length_mismatch")
        sidecar, side_attrs = one(identifier + ".json", 8192, True)
        side_state, old_name = "missing", None
        if sidecar is not None:
            try:
                document = json.loads(sidecar)
                old_name = document.get("name") if isinstance(document, dict) else None
                side_state = "name" if isinstance(old_name, str) and old_name else "unverified_name"
            except (ValueError, UnicodeError):
                side_state = "malformed"
        return raw, {
            "file": attrs,
            "sidecar": {
                "state": side_state,
                "rawBase64": base64.b64encode(sidecar).decode() if sidecar is not None else None,
                "sha256": sha(sidecar) if sidecar is not None else None,
                "attributes": side_attrs,
            },
            "historicalUploaderVerified": False,
            "nameSource": "current_owner_explicit",
            "entireSourceComplete": False,
        }
    except OSError:
        raise SourceMismatch("font_source_file_missing_or_unsafe") from None
    finally:
        for handle in reversed(handles):
            os.close(handle)
