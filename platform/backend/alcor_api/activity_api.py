"""Owned platform audit activity, projected into the legacy display contract."""

import re

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .security import COOKIE, Identity, digest, identity, lock_mutation_identity

_FAT_BEARER = re.compile(r"Bearer fat_[A-Za-z0-9_-]{43}\Z")
_LOGS = (
    "SELECT a.id,a.action,a.target_id,a.created_at,"
    "coalesce(nullif(p.display_name,''),u.username) AS username "
    "FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id "
    "LEFT JOIN user_profiles p ON p.user_id=u.id "
    "WHERE (%s::text IS NULL OR a.actor_id=%s) "
    "ORDER BY a.created_at DESC,a.id DESC LIMIT 200"
)


def legacy_activity_client(request):
    """Old cookies select the reviewed read. An Alcor session keeps the current function."""
    if COOKIE in request.cookies:
        return False
    return bool(request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or "authorization" in request.headers)


def project_activity(rows):
    return [
        {
            "id": str(row["id"]),
            "event": row["action"],
            "detail": row["target_id"] or "",
            "ip": "",
            "createdAt": row["created_at"].isoformat(),
            "userName": row["username"] or "系统",
        }
        for row in rows
    ]


async def activity_logs(conn, owner=None):
    rows = await (await conn.execute(_LOGS, (owner, owner))).fetchall()
    return project_activity(rows)


def legacy_unauthorized():
    return JSONResponse({"error": "未登录"}, status_code=401)


async def legacy_activity_user(db, request):
    authorization = request.headers.get("authorization") or ""
    if "authorization" in request.headers and (len(request.headers.getlist("authorization")) != 1
            or not authorization.startswith("Bearer ") or not re.fullmatch(r"[a-fA-F0-9]{64}", authorization[7:].strip())):
        return None
    if _FAT_BEARER.fullmatch(authorization):
        return None
    if authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
    else:
        # GET does not check Origin. fire_session wins over stocklog_session.
        token = request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or ""
    if not token or len(token) > 128:
        return None
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                """SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.token_hash=%s AND s.client_id='legacy-web' AND s.expires_at>clock_timestamp()
                     AND s.session_version=u.session_version AND u.active""",
                (digest(token),),
            )
        ).fetchone()
    if not row:
        return None
    who = Identity(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        token_hash=digest(token),
        csrf="",
        expires_at=row["expires_at"],
    )
    who.legacy_client = True
    return who


async def legacy_activities(db, request):
    who = await legacy_activity_user(db, request)
    if who is None:
        return legacy_unauthorized()
    try:
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=who.role == "admin")
            result = {
                "userLogs": await activity_logs(conn, who.id),
                "systemLogs": await activity_logs(conn) if who.role == "admin" else [],
            }
    except HTTPException:
        return legacy_unauthorized()
    return JSONResponse(
        result, headers={"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"}
    )


def mount_activity(app, settings, db):
    @app.get('/api/activities/imported')
    async def imported_activity(request: Request):
        from .personal_data_transfer import PersonalDataTransfer, legacy_activities_on_connection
        from .record_file_api import actor

        if set(request.query_params) - {'offset'}:
            raise HTTPException(400, '不接受这些查询参数')
        try:
            offset = int(request.query_params.get('offset', '0'))
        except ValueError:
            raise HTTPException(400, '分页位置无效') from None
        if not 0 <= offset <= 50000:
            raise HTTPException(400, '分页位置无效')
        who = await actor(request, db)
        async with db.connection() as conn, conn.transaction():
            await PersonalDataTransfer(db).lock(conn, who)
            result = await legacy_activities_on_connection(conn, who.id, offset=offset)
        return JSONResponse(result, headers={'Cache-Control': 'private, no-store',
                                             'Vary': 'Cookie, Authorization'})

    @app.get("/api/activities")
    async def activity(request: Request):
        if legacy_activity_client(request):
            return await legacy_activities(db, request)
        headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"}
        try:
            assert_native_origin(request, settings)
            if "authorization" in request.headers:
                from .legacy_optional_credentials import credentials_present

                credentials_present(request)
                raise HTTPException(403, "请使用当前网页登录会话")
            who = await identity(request) if COOKIE in request.cookies else (await web_identity(request, db, allow_platform=True))[0]
            async with db.connection() as conn, conn.transaction():
                await lock_mutation_identity(conn, who, require_admin=who.role == "admin")
                result = {
                    "userLogs": await activity_logs(conn, who.id),
                    "systemLogs": await activity_logs(conn) if who.role == "admin" else [],
                }
            return JSONResponse(result, headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code, headers=headers)
