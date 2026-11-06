"""Canonical owner API. Every GET reads only; demand mutation is explicit and receipted."""

from uuid import UUID

from fastapi import HTTPException, Request

from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, body, native_identity, web_identity
from .market_contract import Query
from .security import COOKIE, identity, lock_mutation_identity


def mount(app, authority):
    app.state.market_candidate = authority

    async def owner(request, write=False):
        if request.headers.get("authorization"):
            assert_native_origin(request, authority.db.settings)
            who = (
                await native_identity(request, authority.db, "portfolio.write" if write else "portfolio.read")
            )[0]
        else:
            who = await identity(request)
        from .security import digest

        if not await app.state.rate_limit(
            authority.db,
            digest("market:" + ("write:" if write else "read:") + who.id),
            60 if write else 180,
            window_seconds=60,
        ):
            raise HTTPException(429, "行情请求过于频繁")
        return who

    @app.get("/api/market/sources")
    async def source_descriptors(request: Request):
        from .market_source_descriptors import describe_sources

        who = await owner(request)
        try:
            return await describe_sources(authority, who)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                exc.headers = {**(exc.headers or {}), "X-Alcor-Retire-Context": "true"}
            raise

    @app.post("/api/market/sources")
    async def configure(request: Request):
        who = await owner(request, True)
        raw = await body(request, ("request_id", "policy_id"), limit=2048)
        if raw.keys() != {"request_id", "policy_id"}:
            raise HTTPException(400, "须指定原请求编号和已获授权来源")
        try:
            return await authority.configure(who, raw["request_id"], raw["policy_id"])
        except (ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "来源参数无效") from exc

    @app.delete("/api/market/sources/{revision}")
    async def revoke_source(revision: UUID, request: Request):
        who = await owner(request, True)
        raw = await body(request, ("request_id",), limit=1024)
        if raw.keys() != {"request_id"}:
            raise HTTPException(400, "须指定原请求编号")
        return await authority.revoke(who, raw["request_id"], revision)

    async def demand(request, remove):
        who = await owner(request, True)
        raw = await body(
            request, ("request_id", "source_revision", "query", "expected_revision"), limit=16384
        )
        if raw.keys() != {"request_id", "source_revision", "query", "expected_revision"}:
            raise HTTPException(400, "行情需求字段无效")
        try:
            return await authority.demand(
                who,
                raw["request_id"],
                raw["source_revision"],
                raw["query"],
                raw["expected_revision"],
                remove=remove,
            )
        except (ValueError, TypeError, AttributeError) as exc:
            raise HTTPException(400, "行情需求参数无效") from exc

    @app.post("/api/market/demands")
    async def register(request: Request):
        return await demand(request, False)

    @app.delete("/api/market/demands")
    async def remove(request: Request):
        return await demand(request, True)

    @app.get("/api/market/demands")
    async def demands(request: Request):
        who = await owner(request)
        include_inactive = request.query_params.get("include_inactive") == "1"
        principal = str(getattr(who, "grant_id", None) or "web:" + who.token_hash)
        async with authority.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await authority.authorize_read(conn, who)
            rows = await (
                await conn.execute(
                    """SELECT d.*,s.query,s.source_revision,(d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp())) AS active
                FROM market_demands d JOIN market_streams s ON s.owner_id=d.owner_id AND s.id=d.stream_id
                WHERE d.owner_id=%s AND ((NOT %s AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp()))
                OR (%s AND d.principal=%s AND d.origin='client')) ORDER BY s.id LIMIT 1001""",
                    (who.id, include_inactive, include_inactive, principal),
                )
            ).fetchall()
            if len(rows) > 1000:
                raise HTTPException(503, "行情需求超过单次读取范围")
            return {
                "items": [
                    {
                        "streamId": str(row["stream_id"]),
                        "sourceRevision": str(row["source_revision"]),
                        "revision": row["revision"],
                        "query": row["query"],
                        "origin": row["origin"],
                        "active": row["active"],
                        "cancellable": row["origin"] == "client"
                        and row["principal"]
                        == str(getattr(who, "grant_id", None) or "web:" + who.token_hash),
                        "expiresAt": row["expires_at"].isoformat() if row["expires_at"] else None,
                    }
                    for row in rows
                ],
                "automaticOnQuoteRead": False,
            }

    @app.get("/api/market/data")
    async def data(
        request: Request,
        source_revision: UUID,
        kind: str,
        market: str,
        code: str,
        frame: str = "latest",
        adjust: str = "none",
        session: str = "REGULAR",
        instrument: str = "equity",
        start: str | None = None,
        through: str | None = None,
        limit: int = 1000,
    ):
        allowed = {
            "source_revision",
            "kind",
            "market",
            "code",
            "frame",
            "adjust",
            "session",
            "instrument",
            "start",
            "through",
            "limit",
        }
        if set(request.query_params) - allowed or any(
            len(request.query_params.getlist(key)) != 1 for key in request.query_params
        ):
            raise HTTPException(400, "不支持的查询参数")
        who = await owner(request)
        return await authority.read(
            who,
            source_revision,
            Query(kind, market, code, frame, adjust, session, instrument, start, through).__dict__,
            limit=limit,
        )

    @app.get("/api/market/operations/{request_id}")
    async def receipt(request_id: UUID, request: Request):
        try:
            if "authorization" in request.headers:
                from .legacy_optional_credentials import credentials_present

                credentials_present(request)
            legacy = "authorization" not in request.headers and COOKIE not in request.cookies and bool(
                request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)
            )
            if legacy:
                assert_native_origin(request, authority.db.settings)
                who = (await web_identity(request, authority.db))[0]
            else:
                who = await owner(request)
            async with authority.db.connection() as conn, conn.transaction():
                if legacy:
                    await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                    await lock_mutation_identity(conn, who, require_admin=False)
                    current = await (
                        await conn.execute("SELECT role FROM users WHERE id=%s", (who.id,))
                    ).fetchone()
                    if not current or current["role"] != who.role:
                        raise HTTPException(403, "读取权限已变化")
                else:
                    await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    await authority.authorize_read(conn, who)
                result = await authority.receipt(conn, who.id, request_id)
                if result is None:
                    raise HTTPException(404, "本人原请求回执不存在")
                if result.get("adminOnly"):
                    current = await (
                        await conn.execute("SELECT role FROM users WHERE id=%s", (who.id,))
                    ).fetchone()
                    if (
                        not current
                        or current["role"] != "admin"
                        or who.role != "admin"
                        or getattr(who, "grant_id", None)
                    ):
                        raise HTTPException(403, "该检查回执需要当前管理员网页登录")
                    if getattr(who,"legacy_client",False) and not getattr(who,"legacy_platform",False):
                        web=await (await conn.execute("SELECT 1 FROM sessions WHERE token_hash=%s AND user_id=%s AND client_id='legacy-web'",(who.token_hash,who.id))).fetchone()
                        if not web:raise HTTPException(403,"此客户端没有管理检查权限")
                return result
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                exc.headers = {**(exc.headers or {}), "X-Alcor-Retire-Context": "true"}
            raise
