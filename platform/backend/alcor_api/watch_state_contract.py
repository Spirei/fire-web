"""Legacy watch display contract; carries no holdings, cash, orders, or fee authority."""

import hashlib
import json
import math
import re

from fastapi import HTTPException

MAX_SAFE_INTEGER = 9007199254740991


def units(value):
    return len(value.encode("utf-16-le")) // 2


def canonical(value):
    # The allowed watch values contain strings/bools/string arrays only. Integer revisions
    # are normalized exactly before hashing; no financial Decimal is converted here.
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def request_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}", value):
        raise HTTPException(400, "requestId 须为小写 UUID")
    return value


def mutation(raw):
    if not isinstance(raw, dict) or set(raw) != {"requestId", "namespace", "changes"} or raw["namespace"] not in ("watch", "fees") or not isinstance(raw["changes"], list) or not 1 <= len(raw["changes"]) <= 1000:
        raise HTTPException(400, "同步修改无效")
    request_id(raw["requestId"])
    changes, keys = [], set()
    try:
        for item in raw["changes"]:
            if not isinstance(item, dict) or set(item) != {"key", "revision", "value"}:
                raise ValueError()
            key, revision, value = item["key"], item["revision"], item["value"]
            if not isinstance(key, str) or not 1 <= units(key) <= 512 or re.search(r"[\x00-\x1f\x7f]", key) or key in ("__proto__", "prototype", "constructor") or key in keys:
                raise ValueError()
            if type(revision) not in (int, float) or not math.isfinite(revision) or revision != int(revision) or not 0 <= revision <= MAX_SAFE_INTEGER:
                raise ValueError()
            if len(canonical(value).encode()) > 64 * 1024:
                raise ValueError()
            changes.append({"key": key, "revision": int(revision), "value": value})
            keys.add(key)
    except (ValueError, TypeError, UnicodeError, OverflowError):
        raise HTTPException(400, "同步字段无效") from None
    result = {"requestId": raw["requestId"], "namespace": raw["namespace"], "changes": changes}
    return result, hashlib.sha256(canonical(result).encode()).hexdigest()


def validate_fields(fields):
    try:
        for key, value in fields.items():
            if value is None:
                continue  # Unknown old display keys may retain a null deletion tombstone.
            try:
                parts = json.loads(key)
            except (ValueError, TypeError):
                raise HTTPException(400, "自选字段无效") from None
            if not isinstance(parts, list) or len(parts) < 2 or any(not isinstance(part, str) or not 1 <= units(part) <= 250 for part in parts):
                raise HTTPException(400, "自选字段无效")
            root = parts[0]
            if root in ("hidden", "pinned") and len(parts) == 2 and value is True:
                continue
            if root == "groups" and len(parts) == 3 and value is True:
                continue
            if root == "orders" and len(parts) == 2 and isinstance(value, list) and len(value) <= 10000 and all(isinstance(item, str) and units(item) <= 250 for item in value) and len(set(value)) == len(value):
                continue
            if root in ("notes", "aliases", "moved") and len(parts) == 2 and isinstance(value, str) and units(value) <= (10000 if root == "notes" else 250):
                continue
            raise HTTPException(400, "自选内容无效")
    except UnicodeError:
        raise HTTPException(400, "自选字段无效") from None
