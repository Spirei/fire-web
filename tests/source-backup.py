#!/usr/bin/env python3
"""Exercise archive recovery, rotation and failures using disposable repositories."""

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('source_backup', Path(__file__).resolve().parents[1] / 'scripts' / 'backup-project.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class SourceBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='alcor-source-backup-test-')
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name).resolve()
        self.source = root / 'source'
        self.source.mkdir()
        self.destination = root / 'backups'
        self.destination.mkdir()
        self.git('init', '-q')
        (self.source / '.gitignore').write_text('data/\nnode_modules/\n.next/\n.env.local\n')
        (self.source / 'README.md').write_text('committed source\n')
        (self.source / '.env.example').write_text('SETTING=\n')
        (self.source / 'deleted.txt').write_text('old source\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial')
        (self.source / 'README.md').write_text('current uncommitted source\n')
        (self.source / 'deleted.txt').unlink()
        (self.source / '新文件.txt').write_text('new source\n')
        (self.source / 'run.sh').write_text('#!/bin/sh\nexit 0\n')
        (self.source / 'run.sh').chmod(0o755)
        (self.source / '.env.local').write_text('PRIVATE_SETTING=local\n')
        self.git('add', '-f', '.env.local')  # Even accidentally tracked private env stays out.
        for folder in ('data', 'node_modules', '.next'):
            (self.source / folder).mkdir()
            (self.source / folder / 'ignored.txt').write_text('runtime content\n')

    def git(self, *args):
        subprocess.check_call(['git', '-C', str(self.source), *args], stdout=subprocess.DEVNULL)

    def run_backup(self):
        return backup.backup(self.source, self.destination)

    def owned(self):
        return sorted(path for path in self.destination.iterdir() if backup.NAME.fullmatch(path.name))

    def test_recover_current_source_and_exclude_private_runtime(self):
        (self.source / 'readme-link').symlink_to('README.md')
        result = self.run_backup()
        metadata = backup.verify(result)
        self.assertEqual({entry['path'] for entry in metadata['entries']},
                         {'.gitignore', '.env.example', 'README.md', '新文件.txt', 'run.sh', 'readme-link'})
        with tarfile.open(result / 'source.tar.gz') as bundle:
            restored = Path(self.temporary.name) / 'restored'
            bundle.extractall(restored)  # verify() already rejected escaping paths/links.
        self.assertEqual((restored / 'README.md').read_text(), 'current uncommitted source\n')
        self.assertEqual((restored / '新文件.txt').read_text(), 'new source\n')
        self.assertEqual((restored / 'run.sh').stat().st_mode & 0o777, 0o755)
        self.assertEqual((restored / 'readme-link').read_text(), 'current uncommitted source\n')
        self.assertEqual((result / 'source.tar.gz').stat().st_mode & 0o777, 0o600)

    def test_rotation_keeps_latest_two_and_leaves_unrelated_files(self):
        first = self.run_backup()
        second = self.run_backup()
        os.utime(first, (2_000_000_000, 2_000_000_000))  # NAS mtime must not decide age.
        foreign = self.destination / 'backup-20000101-000000-12345678'
        shutil.copytree(first, foreign)
        record = json.loads((foreign / 'manifest.json').read_text())
        record['source'] = 'other-project'
        (foreign / 'manifest.json').write_text(json.dumps(record))
        note = self.destination / 'keep.txt'
        note.write_text('unrelated')
        third = self.run_backup()
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.assertTrue(third.exists())
        self.assertTrue(foreign.exists())
        self.assertEqual(note.read_text(), 'unrelated')

    def test_corrupted_nas_copy_never_replaces_previous_backups(self):
        self.run_backup()
        self.run_backup()
        before = self.owned()
        real_copy = shutil.copyfile

        def corrupt(source, destination):
            result = real_copy(source, destination)
            if Path(destination).name == 'source.tar.gz':
                with Path(destination).open('ab') as stream:
                    stream.write(b'corrupted')
            return result

        with patch.object(backup.shutil, 'copyfile', side_effect=corrupt):
            with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                self.run_backup()
        self.assertEqual(self.owned(), before)
        self.assertFalse(list(self.destination.glob('.pending-*')))
        for folder in before:
            backup.verify(folder)

    def test_partial_write_failure_cleans_only_new_staging(self):
        previous = self.run_backup()
        with patch.object(backup.shutil, 'copyfile', side_effect=OSError('disk unavailable')):
            with self.assertRaisesRegex(OSError, 'disk unavailable'):
                self.run_backup()
        self.assertEqual(self.owned(), [previous])
        self.assertFalse(list(self.destination.glob('.pending-*')))
        backup.verify(previous)

    def test_source_change_during_pack_preserves_previous_backup(self):
        previous = self.run_backup()
        real_inventory = backup.inventory
        calls = 0

        def changing_inventory(source):
            nonlocal calls
            calls += 1
            if calls == 2:
                (source / 'README.md').write_text('changed during backup\n')
            return real_inventory(source)

        with patch.object(backup, 'inventory', side_effect=changing_inventory):
            with self.assertRaisesRegex(RuntimeError, '源码发生变化'):
                self.run_backup()
        self.assertEqual(self.owned(), [previous])
        self.assertFalse(list(self.destination.glob('.pending-*')))

    def test_missing_mount_and_overlapping_run_keep_old_archive(self):
        previous = self.run_backup()
        with patch.object(backup.os.path, 'ismount', return_value=False):
            with self.assertRaisesRegex(RuntimeError, '未挂载'):
                backup.backup(self.source, self.destination, Path(self.temporary.name))
        with (self.source / '.git' / 'alcor-source-backup.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.run_backup()
        self.assertEqual(self.owned(), [previous])

    def test_external_link_is_rejected_before_publication(self):
        previous = self.run_backup()
        outside = Path(self.temporary.name) / 'outside.txt'
        outside.write_text('external content')
        (self.source / 'outside-link').symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, '项目外部'):
            self.run_backup()
        self.assertEqual(self.owned(), [previous])


if __name__ == '__main__':
    unittest.main()
