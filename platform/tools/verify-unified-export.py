#!/usr/bin/env python3
"""Verify an encrypted migration export offline; never restore or apply it."""
import argparse
import base64
import json
import os
from pathlib import Path
import stat
import sys
from dataclasses import replace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from alcor_api.unified_export_verify import DEFAULT_LIMITS, VerificationFailure, verify


def read_key(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("key_file_unsafe")
        raw = os.read(descriptor, 66)
        if os.read(descriptor, 1):
            raise ValueError("key_file_invalid")
    finally:
        os.close(descriptor)
    if len(raw) == 32:
        return raw
    encoded = raw[:-1] if raw.endswith(b"\n") else raw
    if len(encoded) != 43:
        raise ValueError("key_file_invalid")
    try:
        decoded = base64.b64decode(encoded + b"=", altchars=b"-_", validate=True)
    except ValueError:
        raise ValueError("key_file_invalid") from None
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).rstrip(b"=") != encoded:
        raise ValueError("key_file_invalid")
    return decoded


def main(argv=None):
    parser = argparse.ArgumentParser(description="离线核验完整迁移包；不会恢复数据库或导入业务数据。")
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--key-file", required=True, type=Path, help="本机仅本人可读的独立密钥文件；不在命令行填写密钥")
    parser.add_argument("--temporary-directory", type=Path, help="有足够空间的本机私有临时目录")
    arguments = parser.parse_args(argv)
    try:
        key = read_key(arguments.key_file)
        limits = DEFAULT_LIMITS
        if arguments.temporary_directory is not None:
            limits = replace(limits, temporary_directory=arguments.temporary_directory)
        result = verify(arguments.bundle, key, limits)
    except VerificationFailure as error:
        print(json.dumps({"state": "rejected", "code": error.code, "applied": False}), file=sys.stderr)
        return 2
    except ValueError as error:
        code = str(error) if str(error) in {"key_file_invalid", "key_file_unsafe"} else "invalid_input"
        print(json.dumps({"state": "rejected", "code": code, "applied": False}), file=sys.stderr)
        return 2
    except OSError:
        print(json.dumps({"state": "rejected", "code": "file_unavailable", "applied": False}), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
