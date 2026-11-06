"""Operator-registered old owned upload paths; no URL fetch or old business call."""

import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit

from .source_authority import definition_hash
from .source_snapshot import canonical, sha
from .watch_group_icons import LIMIT


class IconSourceError(ValueError):
    pass


def directory(path):
    if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)):
        raise IconSourceError('source_icon_root_unsafe')
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode) or value.st_mode & 0o022:
        raise IconSourceError('source_icon_root_unsafe')
    return value.st_dev, value.st_ino


def filename(reference, owner, group):
    if not isinstance(reference, str) or len(reference) > 2048 or any(ord(c) < 32 for c in reference):
        raise IconSourceError('source_icon_reference_invalid')
    value = urlsplit(reference)
    if value.scheme or value.netloc or value.fragment:
        raise IconSourceError('source_icon_external_reference_not_allowed')
    if not re.fullmatch('[A-Za-z0-9_-]{1,200}', owner) or not re.fullmatch('[A-Za-z0-9_-]{1,100}', group):
        raise IconSourceError('source_icon_owner_group_not_supported')
    prefix = '/uploads/asset/group/'+owner+'/'+group+'/'
    if not value.path.startswith(prefix):
        raise IconSourceError('source_icon_not_owned_group_path')
    try:
        name = unquote_to_bytes(value.path[len(prefix):]).decode('utf-8')
    except UnicodeError:
        raise IconSourceError('source_icon_filename_invalid') from None
    if not re.fullmatch('[A-Za-z0-9._-]{1,200}', name) or '..' in name:
        raise IconSourceError('source_icon_filename_invalid')
    if name.rsplit('.', 1)[-1].lower() not in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'):
        raise IconSourceError('source_icon_extension_not_supported')
    return name


@dataclass(frozen=True)
class IconRoot:
    alias: str
    root: Path = field(repr=False)
    identity: tuple[int, int]
    definition: object = field(repr=False)

    def binding(self):
        return sha(canonical({'source': definition_hash(self.definition), 'root': str(self.root), 'rootIdentity': self.identity, 'layout': 'watch-group-owned-upload-v1'}))

    def check(self, owner):
        self.definition.require_access(owner)
        if directory(self.root) != self.identity:
            raise IconSourceError('source_icon_root_identity_changed')

    def read(self, owner, group, reference):
        name = filename(reference, owner, group)
        descriptors = []
        try:
            self.check(owner)
            root = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); descriptors.append(root)
            if (os.fstat(root).st_dev, os.fstat(root).st_ino) != self.identity:
                raise IconSourceError('source_icon_root_identity_changed')
            parent = root; opened = []
            for part in (owner, group):
                self.check(owner)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent); descriptors.append(child)
                info = os.fstat(child)
                if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
                    raise IconSourceError('source_icon_directory_unsafe')
                opened.append((parent, part, info.st_dev, info.st_ino)); parent = child
            self.check(owner)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent); descriptors.append(fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_mode & 0o022 or not 1 <= before.st_size <= LIMIT:
                raise IconSourceError('source_icon_file_unsafe_or_too_large')
            raw = bytearray()
            while True:
                self.check(owner)
                chunk = os.read(fd, min(65536, LIMIT+1-len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > LIMIT:
                    raise IconSourceError('source_icon_file_changed')
            after = os.fstat(fd)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(raw) != before.st_size:
                raise IconSourceError('source_icon_file_changed')
            self.check(owner)
            for parent_fd, part, dev, ino in opened:
                value = os.stat(part, dir_fd=parent_fd, follow_symlinks=False)
                if (value.st_dev, value.st_ino) != (dev, ino):
                    raise IconSourceError('source_icon_directory_changed')
            same = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (same.st_dev, same.st_ino) != (before.st_dev, before.st_ino):
                raise IconSourceError('source_icon_file_changed')
            return name, bytes(raw), {'device': str(before.st_dev), 'inode': str(before.st_ino), 'size': before.st_size, 'mtimeNs': str(before.st_mtime_ns), 'ctimeNs': str(before.st_ctime_ns)}
        except OSError:
            raise IconSourceError('source_icon_file_missing_or_unsafe') from None
        finally:
            for fd in reversed(descriptors):
                os.close(fd)


def load_icon_roots(settings, registry):
    path = settings.watch_group_icon_import_registry_path
    if path is None:
        return {}
    try:
        path = Path(path); info = path.lstat(); parent = path.parent.lstat()
        if not path.is_absolute() or any(p.is_symlink() for p in (path, *path.parents)) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536 or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            raise ValueError()
        doc = json.loads(path.read_bytes())
        if set(doc) != {'version', 'platformInstance', 'roots'} or doc['version'] != 1 or doc['platformInstance'] != str(settings.instance_id) or not isinstance(doc['roots'], list) or not 1 <= len(doc['roots']) <= 8:
            raise ValueError()
        result = {}
        for item in doc['roots']:
            if set(item) != {'sourceAlias', 'root', 'rootIdentity', 'layout'} or item['sourceAlias'] not in registry or item['sourceAlias'] in result or item['layout'] != 'watch-group-owned-upload-v1' or not isinstance(item['rootIdentity'], list) or len(item['rootIdentity']) != 2 or any(type(n) is not int or n < 0 for n in item['rootIdentity']):
                raise ValueError()
            result[item['sourceAlias']] = IconRoot(item['sourceAlias'], Path(item['root']), tuple(item['rootIdentity']), registry[item['sourceAlias']])
        return result
    except (OSError, ValueError, TypeError, KeyError):
        raise IconSourceError('source_icon_registration_invalid') from None
