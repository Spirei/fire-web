"""Narrow permissions only on application-owned private directories; never take ownership."""
import os
import stat
from pathlib import Path


def owned_directory(value):
    path = Path(value)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or not stat.S_ISDIR(info.st_mode):
            raise PermissionError('Private directory owner mismatch')
        if info.st_mode & 0o077:
            os.fchmod(fd, 0o700)
        if os.fstat(fd).st_mode & 0o077:
            raise PermissionError('Private directory mode mismatch')
    finally:
        os.close(fd)
    return path


def prepare_existing(settings):
    """Startup maintenance, separate from read routes. Never chmod a shared mount."""
    outcomes = {}
    for kind, path in (
        ('profile-media', settings.file_root / 'profile-media' if settings.file_root else None),
        ('credentials', settings.connection_secret_dir),
    ):
        if path is None or not Path(path).exists():
            continue
        try:
            owned_directory(path)
            outcomes[kind] = 'ready'
        except OSError:
            outcomes[kind] = 'unavailable'
    return outcomes
