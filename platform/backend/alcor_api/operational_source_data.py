"""Finite fixed-file reads. No HTTP locator, no physical database archive, no old business calls."""

import math
import os
import stat
import time
from contextlib import closing
from datetime import UTC, datetime, timedelta

from .operational_request_templates import TEMPLATES
from .operational_source_registry import directory
from .source_snapshot import SourceMismatch, canonical, sha

KINDS = {"document1", "document2", "requests", "request_daily", "request_hours"}
PAGE = 500


def read_document(source, version):
    if version not in (1, 2):
        raise SourceMismatch("operational_document_version_invalid")
    scope = "global-api-documents"
    source.require_access(scope)
    descriptors = []
    try:
        root = os.open(source.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(root)
        if (os.fstat(root).st_dev, os.fstat(root).st_ino) != source.root_identity:
            raise SourceMismatch("operational_source_root_changed")
        docs = os.open("docs", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        descriptors.append(docs)
        name = "api-spec.md" if version == 1 else "api-spec-v2.md"
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=docs)
        descriptors.append(fd)
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or before.st_size > 524288
        ):
            raise SourceMismatch("operational_document_unsafe")
        raw = bytearray()
        while len(raw) <= 524288:
            source.require_access(scope)
            part = os.read(fd, min(65536, 524289 - len(raw)))
            if not part:
                break
            raw.extend(part)
        after, linked = os.fstat(fd), os.stat(name, dir_fd=docs, follow_symlinks=False)
        signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if (
            len(raw) > 524288
            or signature(before) != signature(after)
            or signature(before) != signature(linked)
        ):
            raise SourceMismatch("operational_document_changed")
        source.require_access(scope)
        content = raw.decode("utf-8")
        if "\x00" in content:
            raise SourceMismatch("operational_document_encoding_unsupported")
        return {
            "version": version,
            "content": content,
            "sha256": sha(raw),
            "bytes": len(raw),
            "readOnly": True,
            "captureComplete": True,
            "historicalVersionsKnown": False,
        }
    except (OSError, UnicodeError):
        raise SourceMismatch("operational_document_missing_or_unsafe") from None
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def metadata(row, kind):
    result = dict(row)
    if (
        any(not isinstance(result.get(key), str) for key in ("path", "method", "source"))
        or result["path"] not in TEMPLATES | {"/api/[unmatched]"}
        or result["method"] not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"}
        or result["source"] not in {"web", "ios", "app", "other"}
        or type(result["status"]) is not int
        or not 100 <= result["status"] <= 599
    ):
        raise SourceMismatch("operational_log_metadata_not_normalized")

    def integer(name, minimum=0):
        value = result[name]
        if type(value) is not int or not minimum <= value <= 9007199254740991:
            raise SourceMismatch("operational_log_numeric_invalid")

    def duration(name):
        value = result[name]
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise SourceMismatch("operational_log_numeric_invalid")

    if kind == "requests":
        integer("id", 1)
        integer("at")
        duration("duration")
        if result["duration"] > 86400000:
            raise SourceMismatch("operational_log_duration_out_of_range")
    else:
        integer("count", 1)
        day = datetime.strptime(result["day"], "%Y-%m-%d").date()
        if day.isoformat() != result["day"]:
            raise SourceMismatch("operational_log_day_invalid")
        if kind == "request_hours":
            integer("hour")
            if (
                result["hour"] % 3600000
                or (datetime.fromtimestamp(result["hour"] / 1000, UTC) + timedelta(hours=8)).date() != day
            ):
                raise SourceMismatch("operational_log_hour_invalid")
        else:
            duration("total_ms")
    return result


def read_logs(source, kind, cursor):
    raise SourceMismatch("source_log_reader_removed")
