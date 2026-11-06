"""Offline receipt archive: preserves source bytes, never replays an operation.

Caller supplies an explicitly reviewed source/target owner binding. No HTTP import
route or source connector exists; this primitive does not establish that binding.
"""

import hashlib
import json
import math
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException

from .portfolio_records import PortfolioRecords


def validate_original_receipt(raw, request_id):
    """Validate but preserve original JSON bytes and both success/failure semantics."""
    if not isinstance(raw, bytes) or len(raw) > 262144:
        raise ValueError("receipt bytes invalid")
    if str(UUID(request_id)) != request_id:
        raise ValueError("request ID invalid")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate receipt key")
            result[key] = value
        return result

    value = json.loads(
        raw.decode("utf-8"),
        object_pairs_hook=unique,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite")),
    )
    fields = {
        "requestId",
        "kind",
        "recordId",
        "state",
        "code",
        "message",
        "record",
        "deleted",
        "revision",
        "collectionRevision",
        "createdAt",
        "completedAt",
    }
    if not isinstance(value, dict) or set(value) != fields or value["requestId"] != request_id:
        raise ValueError("receipt shape invalid")
    if value["kind"] not in {"create", "update", "delete"} or value["state"] not in {"completed", "failed"}:
        raise ValueError("receipt operation invalid")
    if (
        type(value["code"]) is not int
        or not isinstance(value["message"], str)
        or type(value["deleted"]) is not bool
    ):
        raise ValueError("receipt outcome invalid")
    if value["state"] == "failed" and (
        value["code"] == 0 or value["record"] is not None or value["revision"] is not None or value["deleted"]
    ):
        raise ValueError("failure outcome invalid")
    if value["state"] == "completed" and value["code"] != 0:
        raise ValueError("success outcome invalid")
    if not isinstance(value["recordId"], str) or len(value["recordId"]) > 100:
        raise ValueError("record identity invalid")
    if value["state"] == "completed":
        if type(value["revision"]) is not int or value["revision"] < 1:
            raise ValueError("success revision invalid")
        if value["kind"] == "delete":
            if value["record"] is not None or not value["deleted"]:
                raise ValueError("delete outcome invalid")
        else:
            record = value["record"]
            if not isinstance(record, dict) or record.get("id") != value["recordId"] or value["deleted"]:
                raise ValueError("record outcome invalid")
            for field in ("name", "code", "market", "group", "note", "updatedAt"):
                if not isinstance(record.get(field), str):
                    raise TypeError("record field invalid")
            for field in ("price", "cost", "qty"):
                number = record.get(field)
                if number not in (None, "") and (
                    type(number) not in (int, float) or not math.isfinite(number)
                ):
                    raise ValueError("record numeric field invalid")
    if type(value["collectionRevision"]) is not int or value["collectionRevision"] < 0:
        raise ValueError("receipt version invalid")
    for field in ("createdAt", "completedAt"):
        if not isinstance(value[field], str) or datetime.fromisoformat(value[field]).tzinfo is None:
            raise ValueError("receipt timestamp invalid")
    return value, hashlib.sha256(raw).hexdigest()


def receipt_envelope(raw, request_id):
    validate_original_receipt(raw, request_id)
    return b'{"code":0,"message":"ok","data":' + raw + b"}"


async def archive_original_receipt(db, *, owner, request_id, raw, source_instance, source_owner_id, import_batch, expected_database, expected_instance):
    """Archive a reviewed offline row in the explicitly addressed target only."""
    request_id = str(UUID(str(request_id)))
    _, sha = validate_original_receipt(raw, request_id)
    source_instance, import_batch = UUID(str(source_instance)), UUID(str(import_batch))
    if not isinstance(source_owner_id, str) or not 1 <= len(source_owner_id) <= 128:
        raise ValueError("source owner invalid")
    if str(db.settings.instance_id) != str(expected_instance):
        raise ValueError("target instance mismatch")
    async with db.connection() as conn, conn.transaction():
        target = await (await conn.execute("SELECT current_database() AS name")).fetchone()
        if target["name"] != expected_database:
            raise ValueError("target database mismatch")
        await PortfolioRecords(db).lock(conn, owner)
        prior = await (await conn.execute("SELECT * FROM portfolio_legacy_receipts WHERE owner_id=%s AND request_id=%s", (owner, request_id))).fetchone()
        if prior:
            if (bytes(prior["original_json"]) == raw and prior["source_instance"] == source_instance
                    and prior["source_owner_id"] == source_owner_id and prior["import_batch"] == import_batch):
                return sha
            raise HTTPException(409, "请求编号已有其他来源回执")
        reserved = await (await conn.execute("SELECT 1 FROM portfolio_request_reservations WHERE owner_id=%s AND request_id=%s", (owner, request_id))).fetchone()
        if reserved:
            raise HTTPException(409, "请求编号已被使用")
        await conn.execute("INSERT INTO portfolio_legacy_receipts(owner_id,request_id,source_instance,source_owner_id,import_batch,original_json,original_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s)", (owner, request_id, source_instance, source_owner_id, import_batch, raw, sha))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'portfolio-records.archive-receipt',%s,%s)", (owner, str(import_batch), request_id))
        return sha
