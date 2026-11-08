"""Finite operator migration access; policy is separate from immutable source identity."""

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from types import SimpleNamespace
from uuid import uuid4

from .source_snapshot import SourceMismatch


class SourceWindowDenied(SourceMismatch):
    pass


@dataclass(frozen=True)
class MigrationWindow:
    not_before: datetime
    expires_at: datetime
    state: str

    def document(self):
        return {
            "notBefore": self.not_before.isoformat().replace("+00:00", "Z"),
            "expiresAt": self.expires_at.isoformat().replace("+00:00", "Z"),
            "state": self.state,
        }


def parse_window(value):
    try:
        if (
            not isinstance(value, dict)
            or set(value) != {"notBefore", "expiresAt", "state"}
            or value["state"] not in ("active", "revoked")
        ):
            return None
        dates = []
        for key in ("notBefore", "expiresAt"):
            raw = value[key]
            if not isinstance(raw, str) or len(raw) > 64:
                return None
            date = datetime.fromisoformat(raw)
            if date.tzinfo is None or date.utcoffset() is None:
                return None
            dates.append(date.astimezone(UTC))
        if dates[0] >= dates[1]:
            return None
        return MigrationWindow(dates[0], dates[1], value["state"])
    except (ValueError, TypeError, OverflowError):
        return None


def window_state(window, now=None):
    if not isinstance(window, MigrationWindow):
        return "unknown"
    now = now or datetime.now(UTC)
    if (
        not isinstance(now, datetime)
        or not isinstance(window.not_before, datetime)
        or not isinstance(window.expires_at, datetime)
    ):
        return "unknown"
    if (
        now.tzinfo is None
        or window.state not in ("active", "revoked")
        or window.not_before.tzinfo is None
        or window.expires_at.tzinfo is None
        or window.not_before >= window.expires_at
    ):
        return "unknown"
    if window.state == "revoked":
        return "revoked"
    if now < window.not_before:
        return "not_started"
    if now >= window.expires_at:
        return "expired"
    return "active"


_cache = {}
_lock = RLock()
_process_id = str(uuid4())
_cache_revisions = {}


def signature(path):
    result = []
    for item in (path, path.parent):
        stat = item.lstat()
        result.append(
            (
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
                stat.st_mode,
                stat.st_uid,
                stat.st_nlink,
            )
        )
    return tuple(result)


def identity_fields(d):
    # Equality only; these private values are never serialized or logged.
    return (
        d.alias,
        d.instance,
        d.kind,
        d.owners,
        d.timezone,
        d.expected_schema_hash,
        d.locator,
        d.expected_database,
        d.expected_data_directory,
        d.expected_role,
        d.expected_file_identity,
        d.expected_dataset_identity,
        d.schema_name,
    )


def current_definition(definition):
    path = getattr(definition, "window_registry_path", None)
    if path is None:
        return definition
    from .source_registry import load_registry

    path = Path(path)
    instance = definition.window_platform_instance
    try:
        key = (str(path), str(instance))
        before = signature(path)
        with _lock:
            cached = _cache.get(key)
            if not cached or cached[0] != before:
                registry = load_registry(
                    SimpleNamespace(legacy_source_registry_path=path, instance_id=instance)
                )
                if signature(path) != before:
                    raise ValueError()
                if len(_cache) >= 32:
                    evicted = next(iter(_cache))
                    _cache.pop(evicted)
                    _cache_revisions[evicted[1]] = _cache_revisions.get(evicted[1], 0) + 1
                _cache[key] = (before, registry)
                _cache_revisions[str(instance)] = _cache_revisions.get(str(instance), 0) + 1
            current = _cache[key][1].get(definition.alias)
        if not current or identity_fields(current) != identity_fields(definition):
            raise SourceWindowDenied("source_migration_registry_changed")
        return current
    except SourceWindowDenied:
        raise
    except (OSError, ValueError, TypeError):
        raise SourceWindowDenied("source_migration_registry_unavailable") from None


def require_source_access(definition, owner=None):
    current = current_definition(definition)
    if owner is not None and owner not in current.owners:
        raise SourceWindowDenied("source_owner_not_allowlisted")
    window = current.migration_window
    state = window_state(window)
    if state != "active":
        raise SourceWindowDenied("source_migration_window_" + state)
    return window


def source_window_status(definition):
    try:
        current = current_definition(definition)
        window = current.migration_window
        state = window_state(window)
        return {"state": state, **(window.document() if isinstance(window, MigrationWindow) else {})} | {
            "state": state
        }
    except SourceWindowDenied:
        return {"state": "unavailable"}


def access_error_message(error):
    return {
        "source_migration_window_expired": "迁移取数窗口已到期",
        "source_migration_window_revoked": "迁移取数窗口已撤销",
        "source_migration_window_not_started": "迁移取数窗口尚未开始",
        "source_migration_window_unknown": "迁移取数窗口未配置或无法核验",
        "source_migration_registry_changed": "迁移来源登记已变化，已停止取数",
        "source_migration_registry_unavailable": "迁移来源登记无法核验，已停止取数",
        "source_owner_not_allowlisted": "来源账号不在操作员允许范围",
    }.get(str(error), "迁移取数权限无法核验")


def cache_snapshot(instance):
    """Metadata only: no registry paths, source owners or definitions escape."""
    with _lock:
        key = str(instance)
        return {"processId": _process_id, "revision": _cache_revisions.get(key, 0),
                "entries": sum(1 for item in _cache if item[1] == key),
                "scope": "current_api_process_current_instance_registry_parse",
                "workerAffected": False, "redisAffected": False}


def clear_instance_cache(instance, process_id, revision):
    from fastapi import HTTPException
    with _lock:
        before = cache_snapshot(instance)
        if process_id != _process_id or type(revision) is not int or before["revision"] != revision:
            raise HTTPException(409, "缓存进程或版本已变化，请重新读取")
        keys = [key for key in _cache if key[1] == str(instance)]
        for key in keys:
            del _cache[key]
        _cache_revisions[str(instance)] = revision + 1
        return {**cache_snapshot(instance), "removed": len(keys)}
