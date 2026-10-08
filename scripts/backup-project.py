#!/usr/bin/env python3
"""Package the working source tree, verify the NAS copy and preserve all backups."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo


SOURCE = Path(__file__).resolve().parents[1]
CONFIG = SOURCE / 'data' / 'source-backup-config.json'
FORMAT = 'alcor-web-source-backup-v1'
EXCLUDED = {'.git', 'node_modules', '.cache', 'out', 'dist', '__pycache__', '.DS_Store'}


def git(source, *args):
    return subprocess.check_output(['git', '-C', str(source), *args])


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(chunk)
    return result.hexdigest()


def format_size(size):
    value = float(size)
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if value < 1000 or unit == 'TB':
            return f'{size} B' if unit == 'B' else f'{value:.2f} {unit}'
        value /= 1000


def safe_name(name):
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and '..' not in path.parts and path.as_posix() == name


def safe_link(name, target):
    if not target or PurePosixPath(target).is_absolute():
        return False
    depth = len(PurePosixPath(name).parent.parts)
    for part in PurePosixPath(target).parts:
        depth += -1 if part == '..' else (0 if part == '.' else 1)
        if depth < 0:
            return False
    return True


def inventory(source):
    # Include current edits and new source files, while honoring repository ignores.
    names = git(source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
    entries = []
    for name in sorted({os.fsdecode(item) for item in names.split(b'\0') if item}):
        parts = PurePosixPath(name).parts
        if (any(part in EXCLUDED or part.startswith('.next') for part in parts)
                or name.endswith('.tsbuildinfo')
                or any(part.startswith('.env') and part != '.env.example' for part in parts)):
            continue
        if not safe_name(name):
            raise RuntimeError('源码清单包含不安全路径')
        path = source / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue  # A deleted tracked file is absent from the working snapshot.
        if not path.resolve().is_relative_to(source):
            raise RuntimeError(f'源码链接指向项目外部：{name}')
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise RuntimeError(f'不支持的源码文件类型：{name}')
        if path.is_symlink() and not safe_link(name, os.readlink(path)):
            raise RuntimeError(f'源码链接不能安全还原：{name}')
        entries.append((name, (info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino)))
    if not entries:
        raise RuntimeError('源码清单为空，保留旧备份')
    return entries


class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.hash = hashlib.sha256()

    def read(self, size):
        data = self.stream.read(size)
        self.hash.update(data)
        return data


def verify(folder):
    for name in ('manifest.json', 'source.tar.gz'):
        if not stat.S_ISREG((folder / name).lstat().st_mode):
            raise RuntimeError('备份包或清单必须是普通文件')
    if (folder / 'manifest.json').stat().st_size > 16 * 1024 * 1024:
        raise RuntimeError('备份清单超过限制')
    metadata = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    if metadata.get('format') != FORMAT:
        raise RuntimeError('备份格式不匹配')
    archive_size = (folder / 'source.tar.gz').stat().st_size
    # Older verified backups have no size field; continue to verify their contents.
    if metadata.get('archiveSize', archive_size) != archive_size:
        raise RuntimeError('备份压缩包大小与清单不一致')
    with (folder / 'source.tar.gz').open('rb') as stream:
        if digest(stream) != metadata['archiveSHA256']:
            raise RuntimeError('备份压缩包 SHA-256 校验失败')
    actual = []
    with tarfile.open(folder / 'source.tar.gz', 'r:gz') as bundle:
        for member in bundle:
            if not safe_name(member.name):
                raise RuntimeError('压缩包包含不安全路径')
            item = {'path': member.name, 'mode': member.mode}
            if member.isfile():
                with bundle.extractfile(member) as stream:
                    item.update(type='file', size=member.size, sha256=digest(stream))
            elif member.issym() and safe_link(member.name, member.linkname):
                item.update(type='symlink', target=member.linkname)
            else:
                raise RuntimeError('压缩包包含非预期条目')
            actual.append(item)
    if actual != metadata['entries']:
        raise RuntimeError('源码文件清单或内容 SHA-256 校验失败')
    return metadata


def pack(source, folder):
    before = inventory(source)
    head = git(source, 'rev-parse', 'HEAD').decode().strip()
    records = []
    archive = folder / 'source.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        for name, fingerprint in before:
            path = source / name
            info = tarfile.TarInfo(name)
            info.mode = stat.S_IMODE(fingerprint[0]) & 0o777
            info.mtime = fingerprint[2] / 1_000_000_000
            item = {'path': name, 'mode': info.mode}
            if stat.S_ISLNK(fingerprint[0]):
                info.type = tarfile.SYMTYPE
                info.linkname = os.readlink(path)
                item.update(type='symlink', target=info.linkname)
                bundle.addfile(info)
            else:
                info.size = fingerprint[1]
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, 'rb') as stream:
                    reader = HashingReader(stream)
                    bundle.addfile(info, reader)
                    item.update(type='file', size=info.size, sha256=reader.hash.hexdigest())
            records.append(item)
    if before != inventory(source) or head != git(source, 'rev-parse', 'HEAD').decode().strip():
        raise RuntimeError('备份期间源码发生变化；保留旧备份，请重新运行')
    with archive.open('rb') as stream:
        archive_hash = digest(stream)
    metadata = {'format': FORMAT, 'source': str(source), 'gitHead': head,
                'createdAt': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
                'archiveSHA256': archive_hash, 'archiveSize': archive.stat().st_size,
                'entries': records}
    (folder / 'manifest.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return metadata


def backup(source, destination, required_mount=None):
    source = source.resolve(strict=True)
    if Path(os.fsdecode(git(source, 'rev-parse', '--show-toplevel')).strip()).resolve() != source:
        raise RuntimeError('源码路径必须是 Git 项目根目录')
    if required_mount is not None:
        required_mount = required_mount.resolve(strict=True)
        if not os.path.ismount(required_mount):
            raise RuntimeError('备份外部卷未挂载，保留旧备份，不回退本地目录')
        if not destination.resolve().is_relative_to(required_mount):
            raise RuntimeError('备份目录必须位于指定外部卷')
    destination = destination.resolve(strict=True)
    if not destination.is_dir() or destination == source or destination.is_relative_to(source):
        raise RuntimeError('备份目录必须是项目外部的现有目录')
    lock_path = Path(os.fsdecode(git(source, 'rev-parse', '--git-path', 'alcor-source-backup.lock')).strip())
    if not lock_path.is_absolute():
        lock_path = source / lock_path
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stamp = datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S')
        final = destination / f'backup-{stamp}-{uuid4().hex[:8]}'
        stage = None
        try:
            with tempfile.TemporaryDirectory(prefix='alcor-source-backup-') as temporary:
                local = Path(temporary)
                metadata = pack(source, local)
                stage = Path(tempfile.mkdtemp(prefix='.pending-', dir=destination))
                for name in ('source.tar.gz', 'manifest.json'):
                    shutil.copyfile(local / name, stage / name)
                    os.chmod(stage / name, 0o600)
                    with (stage / name).open('rb') as stream:
                        os.fsync(stream.fileno())
                if verify(stage) != metadata:
                    raise RuntimeError('NAS 清单与原始备份不一致')
                os.rename(stage, final)
        except BaseException:
            if stage is not None and stage.exists():
                shutil.rmtree(stage)
            raise
        print(f'已创建并校验：{final}')
        print(f'源码文件：{len(metadata["entries"])}；保留全部历史源码备份')
        size = metadata['archiveSize']
        print(f'压缩包大小：{format_size(size)}（{size:,} 字节）')
        return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--required-mount', type=Path)
    parser.add_argument('--verify', type=Path, help='只校验已有备份')
    args = parser.parse_args()
    if args.verify:
        metadata = verify(args.verify)
        print(f'校验通过：{args.verify}；{len(metadata["entries"])} 个源码文件')
        size = (args.verify / 'source.tar.gz').stat().st_size
        print(f'压缩包大小：{format_size(size)}（{size:,} 字节）')
        return
    if args.destination is None:
        config = json.loads(CONFIG.read_text(encoding='utf-8'))
        args.destination = Path(config['destination'])
        args.required_mount = Path(config['requiredMount'])
        if not args.destination.is_absolute() or not args.required_mount.is_absolute():
            raise RuntimeError('本地备份配置必须使用绝对路径')
    backup(args.source, args.destination, args.required_mount)


if __name__ == '__main__':
    main()
