"""Own source evidence history; read-only queries never contact an old source."""

from uuid import UUID

from fastapi import HTTPException, Request, Response

from .security import identity, lock_mutation_identity


def paging(query, allowed=()):
    if set(query) - {"limit", "cursor", *allowed} or any(len(query.getlist(k)) != 1 for k in query):
        raise HTTPException(400, "查询字段无效")
    limit = query.get("limit", "20")
    if not limit.isascii() or not limit.isdecimal() or len(limit) > 2 or not 1 <= int(limit) <= 50:
        raise HTTPException(400, "每页条数须为1至50")
    cursor = query.get("cursor")
    if cursor:
        try:
            if str(UUID(cursor)) != cursor:
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(400, "分页位置无效") from None
    return int(limit), cursor


def mount_source_history(app):
    authority = app.state.source_authority
    db = app.state.db

    async def member(request, response):
        response.headers["Cache-Control"] = "no-store, private"
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页登录会话")
        return await identity(request)

    @app.get("/api/legacy-financial/registration-options")
    async def options(request: Request, response: Response):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        who = await member(request, response)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=True)
            # Public aliases and the configured owner allowlist only; no DSN,
            # path, secrets, probe, or filesystem access occurs on this read.
            return {
                "items": [
                    {
                        "alias": d.alias,
                        "sourceInstance": d.instance,
                        "kind": d.kind,
                        "owners": list(d.owners),
                        "migrationWindow": d.window_status(),
                    }
                    for d in authority.registry.values()
                ]
            }

    @app.get("/api/legacy-financial/manifests")
    async def manifests(request: Request, response: Response):
        limit, cursor = paging(request.query_params)
        who = await member(request, response)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            after = None
            if cursor:
                after = await (
                    await conn.execute(
                        "SELECT id,created_at FROM legacy_source_manifests WHERE owner_id=%s AND id=%s",
                        (who.id, cursor),
                    )
                ).fetchone()
                if not after:
                    raise HTTPException(400, "分页位置无效")
            rows = await (
                await conn.execute(
                    """SELECT m.id,m.grant_id,m.grant_revision,m.manifest_sha256,m.predecessor_hash,m.created_at,
              m.manifest->'source' source,m.manifest->'coverage' coverage,
              m.manifest->>'rawSha256' raw_sha256,
              jsonb_array_length(coalesce(m.manifest->'normalizationBlockers','[]')) blocker_count,
              coalesce((SELECT jsonb_agg(b.value) FROM jsonb_array_elements(coalesce(m.manifest->'normalizationBlockers','[]')) WITH ORDINALITY b(value,n) WHERE b.n<=20),'[]') blockers,
              h.manifest_id=m.id is_head,
              (SELECT count(*) FROM financial_import_operations f WHERE f.owner_id=m.owner_id AND f.result->>'sourceId'=m.id::text AND f.result->>'state'='completed' AND f.result->>'financialApplied'='true') financial_receipts
              FROM legacy_source_manifests m LEFT JOIN legacy_source_heads h ON h.owner_id=m.owner_id
              WHERE m.owner_id=%s AND (%s::timestamptz IS NULL OR (m.created_at,m.id)<(%s::timestamptz,%s::uuid))
              ORDER BY m.created_at DESC,m.id DESC LIMIT %s""",
                    (
                        who.id,
                        after["created_at"] if after else None,
                        after["created_at"] if after else None,
                        after["id"] if after else None,
                        limit + 1,
                    ),
                )
            ).fetchall()
            head = await (
                await conn.execute(
                    "SELECT manifest_id,manifest_sha256,revision FROM legacy_source_heads WHERE owner_id=%s",
                    (who.id,),
                )
            ).fetchone()
            return {
                "items": [
                    {
                        "id": str(r["id"]),
                        "grantId": str(r["grant_id"]),
                        "grantRevision": r["grant_revision"],
                        "manifestSha256": r["manifest_sha256"],
                        "predecessorHash": r["predecessor_hash"],
                        "rawSha256": r["raw_sha256"],
                        "createdAt": r["created_at"].isoformat(),
                        "source": r["source"],
                        "coverage": r["coverage"],
                        "blockerCount": r["blocker_count"],
                        "blockers": r["blockers"],
                        "isHead": bool(r["is_head"]),
                        "confirmedFinancialReceipts": r["financial_receipts"],
                    }
                    for r in rows[:limit]
                ],
                "nextCursor": str(rows[limit - 1]["id"]) if len(rows) > limit else None,
                "head": {
                    "id": str(head["manifest_id"]),
                    "manifestSha256": head["manifest_sha256"],
                    "revision": head["revision"],
                }
                if head
                else None,
            }

    @app.get("/api/legacy-financial/operations")
    async def operations(request: Request, response: Response):
        limit, cursor = paging(request.query_params)
        who = await member(request, response)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            after = None
            if cursor:
                after = await (
                    await conn.execute(
                        "SELECT request_id,created_at FROM legacy_source_operations WHERE owner_id=%s AND request_id=%s",
                        (who.id, cursor),
                    )
                ).fetchone()
                if not after:
                    raise HTTPException(400, "分页位置无效")
            rows = await (
                await conn.execute(
                    """SELECT request_id,state,result,created_at FROM legacy_source_operations WHERE owner_id=%s
              AND (%s::timestamptz IS NULL OR (created_at,request_id)<(%s::timestamptz,%s::uuid))
              ORDER BY created_at DESC,request_id DESC LIMIT %s""",
                    (
                        who.id,
                        after["created_at"] if after else None,
                        after["created_at"] if after else None,
                        after["request_id"] if after else None,
                        limit + 1,
                    ),
                )
            ).fetchall()
            return {
                "items": [
                    {
                        "requestId": str(r["request_id"]),
                        "state": r["state"],
                        "createdAt": r["created_at"].isoformat(),
                        "result": r["result"],
                    }
                    for r in rows[:limit]
                ],
                "nextCursor": str(rows[limit - 1]["request_id"]) if len(rows) > limit else None,
            }
