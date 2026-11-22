"""Old Web/native record protocols over the one platform record authority."""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .legacy_identity import (
    LegacyError,
    assert_native_origin,
    envelope,
    native_identity,
    native_version,
    web_identity,
)
from .portfolio_records import PortfolioRecords, record_dto
from .native_ledger import ledger_head
from .native_ledger_projection import collection_revision, positions_with_brokers


def legacy_record(record):
    value = {key: record[key] for key in ("id", "name", "code", "market", "group", "watchGroupId", "watchGroupSort", "note", "revision")}
    for key in ("price", "cost", "qty"):
        value[key] = "" if record[key] is None else float(record[key])
    for key in ("accountMarket", "brokerAccountId", "source"):
        if record[key]:
            value[key] = record[key]
    value["updatedAt"] = datetime.fromisoformat(record["updatedAt"]).astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return value


async def portfolio_member(request, settings, db, *, write=False):
    version = native_version(request)
    assert_native_origin(request, settings)
    authorization = request.headers.get("authorization")
    if version == 2 or authorization is not None and authorization.startswith("Bearer fat_"):
        who,grant=await native_identity(request,db,"portfolio.write" if write else "portfolio.read")
        from .native_app_auth import CLIENT
        if grant['client_id']!=CLIENT:
            raise LegacyError(401,40101,'连接已失效')
        return who
    if authorization is not None and not authorization.startswith("Bearer "):
        raise LegacyError(401, 40101, "未登录")
    return (await web_identity(request, db, allow_v1_bearer=True))[0]


def page_value(raw, default, maximum):
    try:
        value = float(raw) if raw is not None else 0
        if not 1 <= value < float("inf"):
            return default
        return min(maximum, int(value))
    except ValueError:
        return default


def collection_value(raw):
    if raw is None:
        return None
    if not raw.isascii() or not raw.isdecimal() or (len(raw) > 1 and raw.startswith("0")) or int(raw) > 9007199254740991:
        raise LegacyError(400, 40001, "集合版本无效")
    return int(raw)


def mount_legacy_portfolio(app, settings, db):
    service = PortfolioRecords(db)

    async def projects(conn, owner, rows, head):
        if not head:
            return rows
        brokers = await (await conn.execute(
            'SELECT id,name FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL', (owner,),
        )).fetchall()
        return positions_with_brokers(rows, head, {row['id']: row for row in brokers})

    def check_revision(expected, revision):
        if expected is not None and revision != expected:
            raise LegacyError(409, 40902, "记录已变化，请重新读取第一页")

    async def list_records(conn, owner, head):
        rows = await (await conn.execute("SELECT r.*,COALESCE(o.display_timestamp,r.updated_at) AS legacy_updated_at FROM portfolio_records r LEFT JOIN portfolio_legacy_ordering o ON o.owner_id=r.owner_id AND o.record_id=r.id WHERE r.owner_id=%s AND r.deleted_at IS NULL ORDER BY COALESCE(o.display_timestamp,r.updated_at) DESC,r.id", (owner,))).fetchall()
        original = [dict(row, updated_at=row["legacy_updated_at"]) for row in rows]
        if head:
            original = await projects(conn, owner, original, head)
            original.sort(key=lambda row: row["id"])
            original.sort(key=lambda row: row["updated_at"], reverse=True)
        return original

    async def snapshot(who, expected=None):
        owner=who.id
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            from .legacy_record_writes import ReadOnlyRecords
            revision = await ReadOnlyRecords(db,who).lock(conn,owner)
            from .scope_coverage import require_global
            await require_global(conn,owner)
            head = await ledger_head(conn, owner)
            revision = collection_revision(revision, head)
            check_revision(expected, revision)
            rows = await list_records(conn, owner, head)
            return [legacy_record(record_dto(row)) for row in rows], revision

    async def paged_snapshot(who, expected, *, market, group, page, size):
        """One bounded page plus its filtered total inside the same snapshot."""
        owner = who.id
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            from .legacy_record_writes import ReadOnlyRecords
            revision = await ReadOnlyRecords(db, who).lock(conn, owner)
            from .scope_coverage import require_global
            await require_global(conn, owner)
            head = await ledger_head(conn, owner)
            revision = collection_revision(revision, head)
            check_revision(expected, revision)
            if head:
                rows = await list_records(conn, owner, head)
                matches = [row for row in rows if (not market or row["market"] == market)
                           and (not group or row["group_name"] == group)]
                selected = matches[(page - 1) * size:page * size]
                return [legacy_record(record_dto(row)) for row in selected], revision, len(matches)
            where, params = "r.owner_id=%s AND r.deleted_at IS NULL", [owner]
            if market:
                where += " AND r.market=%s"
                params.append(market)
            if group:
                where += " AND r.group_name=%s"
                params.append(group)
            source = (" FROM portfolio_records r LEFT JOIN portfolio_legacy_ordering o "
                      "ON o.owner_id=r.owner_id AND o.record_id=r.id WHERE " + where)
            total = (await (await conn.execute("SELECT count(*) AS n" + source, params)).fetchone())["n"]
            rows = await (await conn.execute(
                "SELECT r.*,COALESCE(o.display_timestamp,r.updated_at) AS legacy_updated_at" + source
                + " ORDER BY COALESCE(o.display_timestamp,r.updated_at) DESC,r.id OFFSET %s LIMIT %s",
                (*params, (page - 1) * size, size),
            )).fetchall()
            return [legacy_record(record_dto(dict(row, updated_at=row["legacy_updated_at"]))) for row in rows], revision, total

    @app.get("/api/records", tags=["legacy-web-portfolio"])
    async def web_list(request: Request, response: Response):
        try:
            if request.headers.get('authorization','').startswith('Bearer fat_'):
                raise LegacyError(401,40101,'接口不接受 App 连接')
            who, _, _ = await web_identity(request, db,allow_v1_bearer=True)
            rows, revision = await snapshot(who, collection_value(request.query_params.get("collectionRevision")))
            response.headers.update({'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
            response.headers["X-Alcor-Account-Id"] = who.id
            response.headers["X-Alcor-Records-Revision"] = str(revision)
            return rows
        except HTTPException as exc:
            return JSONResponse({"error": str(exc.detail), "code": getattr(exc, "business_code", exc.status_code * 100 + 1)}, status_code=exc.status_code, headers=exc.headers)

    @app.get("/api/v{version}/records", tags=["legacy-native-portfolio"])
    async def native_list(version: int, request: Request, response: Response):
        response.headers.update({'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
        who = await portfolio_member(request, settings, db)
        params = request.query_params
        market, group = params.get("market", "").upper(), params.get("group", "").strip()
        page, size = page_value(params.get("page"), 1, 1_000_000), page_value(params.get("pageSize"), 20, 100)
        rows, revision, total = await paged_snapshot(
            who, collection_value(params.get("collectionRevision")),
            market=market, group=group, page=page, size=size,
        )
        result = envelope(rows, request, response)
        result["meta"] = {"page": page, "pageSize": size, "total": total, "collectionRevision": revision}
        return result

    @app.get("/api/v{version}/records/operations/{request_id}", tags=["legacy-native-portfolio"])
    async def operation(version: int, request_id: str, request: Request, response: Response):
        response.headers.update({'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
        who = await portfolio_member(request, settings, db)
        try:
            identifier = UUID(request_id)
            if str(identifier) != request_id:
                raise ValueError()
        except ValueError:
            raise LegacyError(400, 40001, "requestId 须为小写 UUID") from None
        async with db.connection() as conn,conn.transaction():
            from .security import lock_mutation_identity
            await lock_mutation_identity(conn,who,require_admin=False)
            from .legacy_record_writes import compatibility_receipt
            compatibility=await compatibility_receipt(conn,who.id,identifier)
            if compatibility:
                return envelope(compatibility['result'],request,response)
            archived = await (await conn.execute("SELECT original_json FROM portfolio_legacy_receipts WHERE owner_id=%s AND request_id=%s", (who.id, identifier))).fetchone()
            if archived:
                from .portfolio_receipts import receipt_envelope
                envelope(None, request, response)
                return Response(content=receipt_envelope(bytes(archived["original_json"]), request_id), media_type="application/json", headers=dict(response.headers))
            row = await (await conn.execute("SELECT result,created_at FROM portfolio_record_operations WHERE owner_id=%s AND request_id=%s", (who.id, identifier))).fetchone()
        if not row:
            raise LegacyError(404, 40401, "未找到已提交回执")
        result = row["result"]
        when = row["created_at"].astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        result = {key: result[key] for key in ("requestId", "kind", "recordId", "state", "deleted", "revision", "collectionRevision")}
        result.update(code=0, message="ok", record=legacy_record(row["result"]["record"]) if row["result"]["record"] else None, createdAt=when, completedAt=when)
        return envelope(result, request, response)

    @app.get("/api/v{version}/records/{record_id}", tags=["legacy-native-portfolio"])
    async def native_record(version: int, record_id: str, request: Request, response: Response):
        response.headers.update({'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
        who = await portfolio_member(request, settings, db)
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            from .legacy_record_writes import ReadOnlyRecords
            revision = await ReadOnlyRecords(db,who).lock(conn,who.id)
            head = await ledger_head(conn, who.id)
            revision = collection_revision(revision, head)
            row = await service.get(conn, who.id, record_id)
            ordering = await (await conn.execute("SELECT display_timestamp FROM portfolio_legacy_ordering WHERE owner_id=%s AND record_id=%s", (who.id, record_id))).fetchone()
            if ordering and row:
                row = dict(row, updated_at=ordering["display_timestamp"])
            rows = await projects(conn, who.id, [row] if row else [], head)
            row = next((entry for entry in rows if entry["id"] == record_id), None)
            if not row:
                raise LegacyError(404, 40401, "记录不存在")
            result = envelope(legacy_record(record_dto(row)), request, response)
            result["meta"] = {"collectionRevision": revision}
            return result
