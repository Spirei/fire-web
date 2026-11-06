"""Registered public clients, explicit user consent and independently revocable PKCE grants."""

import base64
import hashlib
import re
import secrets
from dataclasses import dataclass
from typing import Annotated
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator

from . import profiles
from .models import InputModel, ProfileInput, ProfileOut
from .security import Identity, administrator, digest, identity, lock_mutation_identity

P = "/api"
SCOPES = {"profile.read": "读取个人资料", "profile.write": "修改个人资料", "activity.read": "读取本人活动"}
router = APIRouter(prefix=P, tags=["client-authorization"])
Member = Annotated[Identity, Depends(identity)]
Admin = Annotated[Identity, Depends(administrator)]


async def recent(conn, who):
    row = await (
        await conn.execute(
            "SELECT created_at>clock_timestamp()-interval '15 minutes' AS ok FROM sessions WHERE token_hash=%s",
            (who.token_hash,),
        )
    ).fetchone()
    if not row or not row["ok"]:
        raise HTTPException(403, "请重新登录后执行此操作")


class ClientInput(InputModel):
    name: str = Field(min_length=1, max_length=80)
    redirect_uris: list[str] = Field(min_length=1, max_length=5)
    scopes: list[str] = Field(min_length=1, max_length=3)
    active: bool = True
    revision: UUID | None

    @field_validator("name")
    @classmethod
    def text(cls, value):
        if not value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError("Invalid name")
        return value.strip()

    @field_validator("redirect_uris")
    @classmethod
    def redirects(cls, values):
        for value in values:
            u = urlsplit(value)
            if (
                len(value) > 1024
                or u.fragment
                or u.username
                or u.password
                or any(ord(c) <= 32 for c in value)
                or "*" in value
            ):
                raise ValueError("Invalid redirect")
            if u.scheme in {"https", "http"}:
                if not u.hostname or (
                    u.scheme == "http" and u.hostname not in {"localhost", "127.0.0.1", "::1"}
                ):
                    raise ValueError("HTTPS required")
                _ = u.port
            elif not (
                re.fullmatch(r"[a-z][a-z0-9.-]+\.[a-z0-9.-]+", u.scheme)
                and not u.netloc
                and u.path.startswith("/")
            ):
                raise ValueError("Invalid native redirect")
        return sorted(set(values))

    @field_validator("scopes")
    @classmethod
    def supported(cls, values):
        if not set(values) <= SCOPES.keys():
            raise ValueError("Unsupported scope")
        return sorted(set(values))


class ConsentInput(InputModel):
    request_id: UUID
    client_id: str = Field(min_length=3, max_length=80)
    redirect_uri: str = Field(max_length=1024)
    scopes: list[str] = Field(min_length=1, max_length=3)
    state: str = Field(min_length=16, max_length=512)
    code_challenge: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    code_challenge_method: str = Field(pattern=r"^S256$")
    device_name: str = Field(default="客户端", min_length=1, max_length=80)
    approve: bool


async def client_row(conn, client_id, *, lock=False):
    row = await (
        await conn.execute(
            "SELECT * FROM registered_clients WHERE client_id=%s" + (" FOR SHARE" if lock else ""),
            (client_id,),
        )
    ).fetchone()
    if not row or not row["active"]:
        raise HTTPException(422, "客户端未登记或已停用")
    return row


def check_request(client, redirect_uri, scopes):
    if redirect_uri not in client["redirect_uris"]:
        raise HTTPException(422, "回调地址未获允许")
    if not scopes or not set(scopes) <= set(client["scopes"]) or not set(scopes) <= SCOPES.keys():
        raise HTTPException(422, "请求权限未获允许")


def web_origins(client):
    return {
        f"{u.scheme}://{u.netloc}"
        for uri in client["redirect_uris"]
        if (u := urlsplit(uri)).scheme in {"http", "https"}
    }


def check_origin(request, client):
    origin = request.headers.get("origin")
    if origin and origin != request.app.state.settings.public_origin and origin not in web_origins(client):
        raise HTTPException(403, "客户端来源未获允许")


async def cors_allowed(db, origin):
    async with db.connection() as conn:
        rows = await (
            await conn.execute("SELECT redirect_uris FROM registered_clients WHERE active")
        ).fetchall()
    return any(origin in web_origins(row) for row in rows)


@router.get("/clients")
async def clients(request: Request, who: Admin):
    async with request.app.state.db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT client_id,name,redirect_uris,scopes,active,revision,updated_at FROM registered_clients ORDER BY name,client_id LIMIT 200"
            )
        ).fetchall()
    return {"items": rows, "scopes": SCOPES}


@router.put("/clients/{client_id}")
async def save_client(client_id: str, data: ClientInput, request: Request, who: Admin):
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,79}", client_id) or client_id in {"new-web", "fire-ios"}:
        raise HTTPException(422, "客户端标识无效或已保留")
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        await recent(conn, who)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("client:" + client_id,))
        old = await (
            await conn.execute(
                "SELECT revision FROM registered_clients WHERE client_id=%s FOR UPDATE", (client_id,)
            )
        ).fetchone()
        if (old["revision"] if old else None) != data.revision:
            raise HTTPException(409, "客户端已更新，请重新读取")
        row = await (
            await conn.execute(
                """INSERT INTO registered_clients(client_id,name,redirect_uris,scopes,active,revision,updated_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(client_id) DO UPDATE SET name=excluded.name,
            redirect_uris=excluded.redirect_uris,scopes=excluded.scopes,active=excluded.active,revision=excluded.revision,
            updated_by=excluded.updated_by,updated_at=clock_timestamp() RETURNING client_id,revision""",
                (client_id, data.name, Jsonb(data.redirect_uris), data.scopes, data.active, uuid4(), who.id),
            )
        ).fetchone()
        await conn.execute(
            "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE client_id=%s",
            (client_id,),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id) VALUES (%s,'client.saved',%s)",
            (who.id, client_id),
        )
    return row


@router.get("/connect/config")
async def discovery(request: Request):
    origin = request.app.state.settings.public_origin
    return {
        "issuer": origin,
        "instance_id": request.app.state.settings.instance_id,
        "authorization_endpoint": origin + "/authorize",
        "token_endpoint": origin + P + "/connect/token",
        "revocation_endpoint": origin + P + "/connect/revoke",
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": list(SCOPES),
        "contract": "platform-connect-v1",
        "legacy_ios_compatible": False,
    }


@router.get("/connect/authorize")
async def consent_context(
    request: Request,
    who: Member,
    client_id: str,
    redirect_uri: str,
    scope: str,
    state: str = Query(min_length=16, max_length=512),
    code_challenge: str = Query(pattern=r"^[A-Za-z0-9_-]{43}$"),
    code_challenge_method: str = Query(pattern=r"^S256$"),
):
    async with request.app.state.db.connection() as conn:
        client = await client_row(conn, client_id)
    scopes = scope.split()
    check_request(client, redirect_uri, scopes)
    return {
        "client_id": client_id,
        "name": client["name"],
        "redirect_uri": redirect_uri,
        "scopes": {s: SCOPES[s] for s in scopes},
    }


@router.post("/connect/authorize")
async def authorize(data: ConsentInput, request: Request, who: Member):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=False)
        client = await client_row(conn, data.client_id, lock=True)
        check_request(client, data.redirect_uri, data.scopes)
        user = await (
            await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
        ).fetchone()
        if data.approve:
            code = secrets.token_urlsafe(32)
            inserted = await (
                await conn.execute(
                    """INSERT INTO authorization_codes(code_hash,request_id,owner_id,client_id,client_revision,session_version,redirect_uri,challenge,device_name,scopes,expires_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp()+interval '2 minutes') ON CONFLICT(owner_id,request_id) DO NOTHING RETURNING code_hash""",
                    (
                        digest(code),
                        data.request_id,
                        who.id,
                        data.client_id,
                        client["revision"],
                        user["session_version"],
                        data.redirect_uri,
                        data.code_challenge,
                        data.device_name,
                        sorted(set(data.scopes)),
                    ),
                )
            ).fetchone()
            if not inserted:
                raise HTTPException(409, "授权请求已处理，请重新发起")
            params = {"code": code, "state": data.state, "iss": request.app.state.settings.public_origin}
        else:
            params = {
                "error": "access_denied",
                "state": data.state,
                "iss": request.app.state.settings.public_origin,
            }
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES (%s,%s,%s,%s)",
            (
                who.id,
                "client.consent.approved" if data.approve else "client.consent.denied",
                data.client_id,
                data.request_id,
            ),
        )
    return {
        "redirect_uri": data.redirect_uri + ("&" if "?" in data.redirect_uri else "?") + urlencode(params)
    }


async def mint(conn, grant_id):
    access = "apt_" + secrets.token_urlsafe(32)
    refresh = "apr_" + secrets.token_urlsafe(32)
    await conn.execute(
        """INSERT INTO client_tokens(access_hash,refresh_hash,grant_id,access_expires_at,refresh_expires_at)
        VALUES (%s,%s,%s,clock_timestamp()+interval '15 minutes',clock_timestamp()+interval '30 days')""",
        (digest(access), digest(refresh), grant_id),
    )
    return {"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 900}


@router.post("/connect/token")
async def token(request: Request):
    if not await request.app.state.rate_limit(
        request.app.state.db, "connect-token:" + str(request.client.host if request.client else "local"), 120
    ):
        return JSONResponse({"error": "temporarily_unavailable"}, status_code=429)
    if request.headers.get("content-type", "").split(";")[0] != "application/x-www-form-urlencoded":
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    try:
        fields = parse_qs((await request.body()).decode("utf-8"), strict_parsing=True, max_num_fields=8)
        if any(len(v) != 1 for v in fields.values()) or set(fields) - {
            "grant_type",
            "client_id",
            "code",
            "redirect_uri",
            "code_verifier",
            "refresh_token",
        }:
            raise ValueError()
        data = {k: v[0] for k, v in fields.items()}
        client_id = data["client_id"]
        grant_type = data["grant_type"]
    except (ValueError, KeyError, UnicodeError):
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    result = None
    async with request.app.state.db.connection() as conn, conn.transaction():
        client = await (
            await conn.execute(
                "SELECT * FROM registered_clients WHERE client_id=%s AND active FOR SHARE", (client_id,)
            )
        ).fetchone()
        if not client:
            return JSONResponse({"error": "invalid_client"}, status_code=400)
        check_origin(request, client)
        if grant_type == "authorization_code":
            row = await (
                await conn.execute(
                    "SELECT *,expires_at>clock_timestamp() AS alive FROM authorization_codes WHERE code_hash=%s AND client_id=%s FOR UPDATE",
                    (digest(data.get("code", "")), client_id),
                )
            ).fetchone()
            if row and row["used_at"] and row["grant_id"]:
                await conn.execute(
                    "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=%s",
                    (row["grant_id"],),
                )
            elif (
                row
                and not row["used_at"]
                and row["alive"]
                and row["client_revision"] == client["revision"]
                and data.get("redirect_uri") == row["redirect_uri"]
                and re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", data.get("code_verifier", ""))
            ):
                challenge = (
                    base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest())
                    .decode()
                    .rstrip("=")
                )
                user = await (
                    await conn.execute(
                        "SELECT * FROM users WHERE id=%s AND active FOR SHARE", (row["owner_id"],)
                    )
                ).fetchone()
                if (
                    secrets.compare_digest(challenge, row["challenge"])
                    and user
                    and user["session_version"] == row["session_version"]
                ):
                    gid = uuid4()
                    await conn.execute(
                        """INSERT INTO client_grants(id,owner_id,client_id,client_revision,session_version,device_name,scopes,expires_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,clock_timestamp()+interval '30 days')""",
                        (
                            gid,
                            row["owner_id"],
                            client_id,
                            client["revision"],
                            row["session_version"],
                            row["device_name"],
                            row["scopes"],
                        ),
                    )
                    await conn.execute(
                        "UPDATE authorization_codes SET used_at=clock_timestamp(),grant_id=%s WHERE code_hash=%s",
                        (gid, row["code_hash"]),
                    )
                    result = await mint(conn, gid)
                    result["scope"] = " ".join(row["scopes"])
        elif grant_type == "refresh_token":
            row = await (
                await conn.execute(
                    """SELECT t.*,g.scopes,g.revoked_at,g.expires_at>clock_timestamp() AS alive,g.client_revision,g.session_version,g.owner_id
                FROM client_tokens t JOIN client_grants g ON g.id=t.grant_id WHERE t.refresh_hash=%s AND g.client_id=%s FOR UPDATE OF g,t""",
                    (digest(data.get("refresh_token", "")), client_id),
                )
            ).fetchone()
            if row and row["refresh_used_at"]:
                await conn.execute(
                    "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=%s",
                    (row["grant_id"],),
                )
            elif (
                row
                and not row["revoked_at"]
                and row["alive"]
                and row["client_revision"] == client["revision"]
            ):
                user = await (
                    await conn.execute(
                        "SELECT session_version FROM users WHERE id=%s AND active FOR SHARE",
                        (row["owner_id"],),
                    )
                ).fetchone()
                fresh = await (
                    await conn.execute(
                        "SELECT refresh_expires_at>clock_timestamp() AS ok FROM client_tokens WHERE access_hash=%s",
                        (row["access_hash"],),
                    )
                ).fetchone()
                if fresh["ok"] and user and user["session_version"] == row["session_version"]:
                    await conn.execute(
                        "UPDATE client_tokens SET refresh_used_at=clock_timestamp() WHERE access_hash=%s",
                        (row["access_hash"],),
                    )
                    result = await mint(conn, row["grant_id"])
                    result["scope"] = " ".join(row["scopes"])
        else:
            return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)
    return result if result else JSONResponse({"error": "invalid_grant"}, status_code=400)


@dataclass
class ClientIdentity(Identity):
    grant_id: UUID
    client_id: str
    scopes: list[str]


async def bearer(request: Request):
    values = request.headers.getlist("authorization")
    if len(values) != 1 or not values[0].startswith("Bearer apt_") or len(values[0]) > 128:
        raise HTTPException(401, "需要有效客户端授权", headers={"WWW-Authenticate": "Bearer"})
    hashed = digest(values[0][7:])
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                """SELECT u.id,u.username,u.role,g.id AS grant_id,g.client_id,g.scopes,t.access_expires_at AS expires_at,c.redirect_uris
            FROM client_tokens t JOIN client_grants g ON g.id=t.grant_id JOIN users u ON u.id=g.owner_id
            JOIN registered_clients c ON c.client_id=g.client_id WHERE t.access_hash=%s AND t.access_expires_at>clock_timestamp()
            AND g.expires_at>clock_timestamp() AND g.revoked_at IS NULL AND u.active AND u.session_version=g.session_version
            AND c.active AND c.revision=g.client_revision""",
                (hashed,),
            )
        ).fetchone()
    if not row:
        raise HTTPException(401, "客户端授权已失效", headers={"WWW-Authenticate": "Bearer"})
    check_origin(request, row)
    row.pop("redirect_uris")
    from .request_activity import bind_account
    bind_account(row["id"])
    return ClientIdentity(**row, token_hash=hashed, csrf="")


async def lock_client_mutation(conn, who):
    if "profile.write" not in who.scopes:
        raise HTTPException(403, "缺少修改资料权限")
    row = await (
        await conn.execute(
            """SELECT g.id FROM client_grants g JOIN client_tokens t ON t.grant_id=g.id
        JOIN users u ON u.id=g.owner_id JOIN registered_clients c ON c.client_id=g.client_id
        WHERE t.access_hash=%s AND g.id=%s AND u.id=%s AND u.active AND u.session_version=g.session_version
        AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND t.access_expires_at>clock_timestamp()
        AND c.active AND c.revision=g.client_revision AND 'profile.write'=ANY(g.scopes) FOR SHARE OF u,g,t,c""",
            (who.token_hash, who.grant_id, who.id),
        )
    ).fetchone()
    if not row:
        raise HTTPException(401, "客户端授权已变化")


def require_scope(who, scope):
    if scope not in who.scopes:
        raise HTTPException(403, "缺少所需权限")


@router.get("/connect/profile", response_model=ProfileOut)
async def get_profile(request: Request, who: Annotated[ClientIdentity, Depends(bearer)]):
    require_scope(who, "profile.read")
    async with request.app.state.db.connection() as conn:
        return await profiles.read_profile(conn, who.id)


@router.get("/connect/session")
async def connected_session(request: Request, who: Annotated[ClientIdentity, Depends(bearer)]):
    require_scope(who, "profile.read")
    return {
        "user": {"id": who.id, "username": who.username},
        "instance_id": request.app.state.settings.instance_id,
        "client_id": who.client_id,
        "grant_id": who.grant_id,
        "scopes": who.scopes,
        "expires_at": who.expires_at,
    }


@router.patch("/connect/profile", response_model=ProfileOut)
async def patch_profile(
    data: ProfileInput, request: Request, who: Annotated[ClientIdentity, Depends(bearer)]
):
    require_scope(who, "profile.write")
    avatar = profiles.normalize_avatar(data.avatar_data) if data.avatar_data else None
    return await profiles.update_profile(request.app.state.db, who, data, avatar, request.state.request_id)


@router.get("/connect/activity")
async def get_activity(request: Request, who: Annotated[ClientIdentity, Depends(bearer)]):
    require_scope(who, "activity.read")
    return await profiles.activity(request.app.state.db, who.id)


@router.get("/grants")
async def grants(request: Request, who: Member):
    async with request.app.state.db.connection() as conn:
        rows = await (
            await conn.execute(
                """SELECT g.id,g.client_id,c.name,g.device_name,g.scopes,g.created_at,g.expires_at,g.revoked_at,
            g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND c.active AND g.client_revision=c.revision AND g.session_version=u.session_version AS active
            FROM client_grants g JOIN registered_clients c ON c.client_id=g.client_id JOIN users u ON u.id=g.owner_id
            WHERE g.owner_id=%s ORDER BY g.created_at DESC LIMIT 200""",
                (who.id,),
            )
        ).fetchall()
    return {"items": rows}


@router.post("/grants/{grant_id}/revoke")
async def revoke_grant(grant_id: UUID, request: Request, who: Member):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=False)
        row = await (
            await conn.execute(
                "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=%s AND owner_id=%s RETURNING id",
                (grant_id, who.id),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "授权不存在")
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id) VALUES (%s,'client.grant.revoked',%s)",
            (who.id, str(grant_id)),
        )
    return {"id": grant_id, "revoked": True}


@router.post("/connect/revoke")
async def revoke_token(request: Request):
    try:
        data = parse_qs((await request.body()).decode(), strict_parsing=True, max_num_fields=4)
        if any(len(v) != 1 for v in data.values()):
            raise ValueError()
        hashed = digest(data["token"][0])
        cid = data["client_id"][0]
    except (ValueError, KeyError, UnicodeError):
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    async with request.app.state.db.connection() as conn:
        client = await client_row(conn, cid)
        check_origin(request, client)
        await conn.execute(
            """UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE client_id=%s AND id IN
            (SELECT grant_id FROM client_tokens WHERE access_hash=%s OR refresh_hash=%s)""",
            (cid, hashed, hashed),
        )
    return Response(status_code=200)
