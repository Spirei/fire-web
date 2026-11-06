"""Manual FIRE planning records, independent of authoritative account valuations."""

from copy import deepcopy
from datetime import datetime
from decimal import Decimal, InvalidOperation

CURRENCIES = frozenset(("USD", "HKD", "CNY", "SGD", "JPY", "KRW", "EUR"))
MAX_AMOUNT = Decimal(1000000000000000)


def valid_amount(value):
    if isinstance(value, bool) or value is None:
        return False
    try:
        amount = Decimal(str(value))
        return amount.is_finite() and 0 < amount <= MAX_AMOUNT
    except (InvalidOperation, ValueError):
        return False


def asset_history(value):
    result = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("recordedAt"), str):
            continue
        try:
            datetime.fromisoformat(item["recordedAt"])
        except ValueError:
            continue
        if (
            valid_amount(item.get("amountBase"))
            and valid_amount(item.get("amountUsd"))
            and item.get("currency") in CURRENCIES
        ):
            result.append(deepcopy(item))
    return sorted(result, key=lambda item: item["recordedAt"])


def merge_plan(stored, incoming, current_year, asset_record=None):
    """Keep prior observations authoritative over submitted planning JSON."""
    result = deepcopy(incoming)
    previous = stored if isinstance(stored, dict) else {}
    if isinstance(previous.get("tableRows"), list):
        frozen = {}
        for row in previous["tableRows"]:
            if not isinstance(row, dict):
                continue
            try:
                year = Decimal(str(row.get("year")))
            except InvalidOperation:
                continue
            if year.is_finite() and year < current_year:
                frozen[year] = row
        if frozen:
            if "baseCurrency" in previous:
                result["baseCurrency"] = previous["baseCurrency"]
            else:
                result.pop("baseCurrency", None)
        merged = []
        for row in result.get("tableRows", []):
            if not isinstance(row, dict):
                merged.append(row)
                continue
            try:
                original = frozen.get(Decimal(str(row.get("year"))))
            except InvalidOperation:
                original = None
            merged.append({**row, **deepcopy(original)} if original else row)
        included = set()
        for row in merged:
            if isinstance(row, dict):
                try:
                    included.add(Decimal(str(row.get("year"))))
                except InvalidOperation:
                    pass
        merged.extend(deepcopy(row) for year, row in frozen.items() if year not in included)
        result["tableRows"] = merged
    history = asset_history(previous.get("assetHistory"))
    if asset_record is not None:
        history.append(deepcopy(asset_record))
    result["assetHistory"] = history[-1500:]
    return result


class FirePlanning:
    def __init__(self, db):
        self.db = db

    async def import_history_on_connection(self, conn, who, request_id, expected_revision, incoming):
        from .fire_transfer import import_on_connection

        return await import_on_connection(conn, who, request_id, expected_revision, incoming)

    async def read(self, who, *, metadata=False):
        from .account_signals import guard

        async with self.db.connection() as conn, conn.transaction():
            await guard(conn, who, "portfolio.read")
            row = await (
                await conn.execute(
                    "SELECT value,revision FROM fire_planning_settings WHERE owner_id=%s", (who.id,)
                )
            ).fetchone()
            return {
                "fire": row["value"] if row else {},
                **({"revision": row["revision"] if row else 0} if metadata else {}),
            }

    async def save(self, who, body):
        import json
        from datetime import UTC
        from zoneinfo import ZoneInfo

        from fastapi import HTTPException
        from psycopg.types.json import Jsonb

        from .account_signals import guard
        from .main import rate_limit
        from .security import digest, lock_mutation_identity

        if not isinstance(body, dict) or not isinstance(body.get("fire"), dict):
            raise HTTPException(400, "无效的请求体")
        import hashlib
        from uuid import UUID

        request_id = body.get("requestId")
        expected = body.get("expectedRevision")
        if request_id is not None or expected is not None:
            try:
                request_id = str(UUID(request_id))
            except (ValueError, TypeError, AttributeError):
                raise HTTPException(400, "操作编号无效") from None
            if type(expected) is not int or expected < 0:
                raise HTTPException(400, "规划版本无效")
        fingerprint = hashlib.sha256(
            json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        incoming = body["fire"]
        if len(json.dumps(incoming, ensure_ascii=False).encode()) > 256 * 1024:
            raise HTTPException(400, "数据过大")
        asset = body.get("assetRecord")
        if asset is not None:
            if (
                not isinstance(asset, dict)
                or not valid_amount(asset.get("amountBase"))
                or not valid_amount(asset.get("amountUsd"))
                or asset.get("currency") not in CURRENCIES
            ):
                raise HTTPException(400, "请输入有效的当前资产")
            asset = {key: asset[key] for key in ("amountBase", "amountUsd", "currency")}
            asset["recordedAt"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (who.id,))
            await lock_mutation_identity(conn, who, require_admin=False)
            await guard(conn, who, "portfolio.write")
            if request_id:
                prior = await (
                    await conn.execute(
                        "SELECT fingerprint,result FROM fire_planning_operations WHERE owner_id=%s AND request_id=%s",
                        (who.id, request_id),
                    )
                ).fetchone()
                if prior:
                    if prior["fingerprint"] != fingerprint:
                        raise HTTPException(409, "操作编号已用于其他内容")
                    return prior["result"]
            if not await rate_limit(self.db, digest("fire:" + who.id), 200, window_seconds=600):
                raise HTTPException(429, "保存过于频繁，请稍后再试")
            row = await (
                await conn.execute(
                    "SELECT value,revision FROM fire_planning_settings WHERE owner_id=%s FOR UPDATE",
                    (who.id,),
                )
            ).fetchone()
            current_revision = row["revision"] if row else 0
            if request_id and expected != current_revision:
                raise HTTPException(409, "规划已变化，请重新读取")
            result = merge_plan(
                row["value"] if row else {}, incoming, datetime.now(ZoneInfo("Asia/Shanghai")).year, asset
            )
            if len(json.dumps(result, ensure_ascii=False).encode()) > 256 * 1024:
                raise HTTPException(400, "数据过大")
            await conn.execute(
                "INSERT INTO fire_planning_settings(owner_id,value) VALUES(%s,%s) ON CONFLICT(owner_id) DO UPDATE SET value=excluded.value,revision=fire_planning_settings.revision+1,updated_at=clock_timestamp()",
                (who.id, Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,%s,%s)",
                (who.id, "fire-planning.saved", who.id),
            )
            response = {"ok": True, "assetHistory": result["assetHistory"]}
            if request_id:
                response.update(requestId=request_id, state="completed", revision=current_revision + 1)
                await conn.execute(
                    "INSERT INTO fire_planning_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                    (who.id, request_id, fingerprint, Jsonb(response)),
                )
            return response

    async def receipt(self, who, request_id):
        from fastapi import HTTPException

        from .account_signals import guard

        async with self.db.connection() as conn, conn.transaction():
            await guard(conn, who, "portfolio.read")
            row = await (
                await conn.execute(
                    "SELECT result FROM fire_planning_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "未查到原操作回执")
            return row["result"]
