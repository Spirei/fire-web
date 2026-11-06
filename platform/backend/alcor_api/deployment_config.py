"""Port of fire-web deployment config and OAuth, with PG CAS and session-bound single-use state."""

import asyncio
import json
import re
import secrets
import urllib.request
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from psycopg.types.json import Jsonb
from pydantic import Field, SecretStr, field_validator

from .admin_verification import VerificationInput, verify_admin_access
from .connections import Vault
from .deployments import Admin
from .models import InputModel
from .security import COOKIE as SESSION_COOKIE
from .security import digest, lock_mutation_identity

router = APIRouter(prefix="/api/deployment", tags=["deployment-configuration"])
COOKIE = "alcor_deploy_oauth"
CALLBACK = "/api/deployment/github/callback"


async def row_for(db):
    async with db.connection() as conn:
        return await (await conn.execute("SELECT * FROM deployment_configuration WHERE singleton")).fetchone()


def view(settings, row):
    return {
        "repository": row["repository"] if row else settings.deployment_repository,
        "revision": str(row["revision"]) if row else None,
        "hasToken": bool(
            (row and (row["token_ciphertext"] or row["oauth_ciphertext"])) or settings.deployment_github_token
        ),
        "githubAccount": row["github_account"] if row else "",
        "oauthAvailable": bool(
            settings.deployment_github_client_id and settings.deployment_github_client_secret
        ),
    }


async def effective(request):
    base = request.app.state.settings
    row = await row_for(request.app.state.db)
    if not row:
        return base
    vault = Vault(base.connection_secret_dir)
    token = row["oauth_ciphertext"] or row["token_ciphertext"]
    secret = (
        SecretStr(vault.decrypt(token, "deployment", base.instance_id))
        if token
        else base.deployment_github_token
    )
    return base.model_copy(
        update={
            "deployment_config_revision": row["revision"],
            "deployment_repository": row["repository"],
            "deployment_image": "ghcr.io/" + row["repository"].lower(),
            "deployment_github_token": secret,
        }
    )


class ConfigInput(InputModel):
    request_id: UUID
    revision: UUID | None = None
    repository: str = Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", max_length=200)
    token: SecretStr = SecretStr("")
    clear_token: bool = Field(default=False, strict=True)

    @field_validator("token")
    @classmethod
    def bounded_token(cls, value):
        token = value.get_secret_value()
        if len(token) > 512 or any(ord(c) < 32 for c in token):
            raise ValueError("invalid credential")
        return value


@router.post("/reauthenticate", status_code=204)
async def verify_deployment_access(data: VerificationInput, request: Request, who: Admin):
    return await verify_admin_access(data, request, who, "deployment")


@router.get("/config")
async def read_config(request: Request, who: Admin):
    return view(request.app.state.settings, await row_for(request.app.state.db))


@router.put("/config")
async def save_config(data: ConfigInput, request: Request, who: Admin):
    settings, db = request.app.state.settings, request.app.state.db
    if settings.deployment_image and "ghcr.io/" + data.repository.lower() != settings.deployment_image:
        raise HTTPException(409, "仓库须对应已登记的 AlcorApi 镜像目标")
    fingerprint = digest(
        data.model_dump_json(
            exclude={"request_id"} if data.clear_token else {"request_id", "clear_token"}
        ).replace("**********", digest(data.token.get_secret_value()))
    )
    token = "" if data.clear_token else data.token.get_secret_value().strip()
    ciphertext = (
        Vault(settings.connection_secret_dir).encrypt(token, "deployment", settings.instance_id)
        if token
        else None
    )
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('alcor.deployment',0))")
        old = await (
            await conn.execute(
                "SELECT fingerprint,result FROM deployment_config_actions WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
        if old:
            if old["fingerprint"] != fingerprint:
                raise HTTPException(409, "此请求编号已用于其他配置")
            return old["result"]
        active = await (
            await conn.execute("SELECT 1 FROM deployment_requests WHERE status IN ('queued','running','unknown')")
        ).fetchone()
        if active:
            raise HTTPException(409, "更新执行期间不能更改发布配置")
        current = await (
            await conn.execute("SELECT * FROM deployment_configuration WHERE singleton FOR UPDATE")
        ).fetchone()
        if (current["revision"] if current else None) != data.revision:
            raise HTTPException(409, "配置已变化，请重新读取后保存")
        row = await (
            await conn.execute(
                """INSERT INTO deployment_configuration(singleton,repository,token_ciphertext) VALUES(true,%s,%s)
            ON CONFLICT(singleton) DO UPDATE SET repository=excluded.repository,
            token_ciphertext=CASE WHEN %s THEN NULL ELSE COALESCE(excluded.token_ciphertext,deployment_configuration.token_ciphertext) END,revision=gen_random_uuid(),updated_at=clock_timestamp() RETURNING *""",
                (data.repository, ciphertext, data.clear_token),
            )
        ).fetchone()
        result = view(settings, row)
        await conn.execute(
            "INSERT INTO deployment_config_actions VALUES(%s,%s,%s,%s)",
            (who.id, data.request_id, fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'deployment.config_saved',%s)",
            (who.id, data.request_id),
        )
    return result


class DisconnectInput(InputModel):
    revision: UUID
    request_id: UUID | None = None


@router.delete("/config")
async def disconnect(data: DisconnectInput, request: Request, who: Admin):
    settings, db = request.app.state.settings, request.app.state.db
    fingerprint = digest("oauth-disconnect:" + str(data.revision))
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('alcor.deployment',0))")
        if data.request_id is not None:
            previous = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM deployment_config_actions WHERE owner_id=%s AND request_id=%s",
                    (who.id, data.request_id),
                )
            ).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise HTTPException(409, "此请求编号已用于其他配置")
                return previous["result"]
        row = await (
            await conn.execute("SELECT * FROM deployment_configuration WHERE singleton FOR UPDATE")
        ).fetchone()
        if not row or row["revision"] != data.revision:
            raise HTTPException(409, "配置已变化，请刷新")
        row = await (
            await conn.execute(
                "UPDATE deployment_configuration SET oauth_ciphertext=NULL,github_account='',revision=gen_random_uuid(),updated_at=clock_timestamp() WHERE singleton RETURNING *"
            )
        ).fetchone()
        result = view(settings, row)
        if data.request_id is not None:
            await conn.execute(
                "INSERT INTO deployment_config_actions VALUES(%s,%s,%s,%s)",
                (who.id, data.request_id, fingerprint, Jsonb(result)),
            )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'deployment.oauth_disconnected',%s)",
            (who.id, data.request_id),
        )
    return result


def callback_url(settings, path=CALLBACK):
    if not settings.public_origin.startswith("https://"):
        raise HTTPException(409, "请配置并通过 AlcorApi 的 HTTPS 域名进行 GitHub 授权")
    return settings.public_origin + path


@router.get("/github/start")
async def oauth_start(request: Request, who: Admin):
    return await oauth_start_for(request, who)


async def oauth_start_for(request, who, *, callback_path=CALLBACK, cookie_name=COOKIE):
    settings, db = request.app.state.settings, request.app.state.db
    if not settings.deployment_github_client_id or not settings.deployment_github_client_secret:
        raise HTTPException(503, "服务端尚未配置 GitHub OAuth App")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "请求来源未获允许")
    callback = callback_url(settings, callback_path)
    state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        config = await (
            await conn.execute("SELECT revision FROM deployment_configuration WHERE singleton FOR SHARE")
        ).fetchone()
        await conn.execute("DELETE FROM deployment_oauth_states WHERE expires_at<clock_timestamp()")
        count = await (
            await conn.execute(
                "SELECT count(*) AS n FROM deployment_oauth_states WHERE owner_id=%s AND consumed_at IS NULL",
                (who.id,),
            )
        ).fetchone()
        if count["n"] >= 20:
            raise HTTPException(429, "授权请求过多，请稍后重试")
        await conn.execute(
            "INSERT INTO deployment_oauth_states(state_hash,cookie_hash,owner_id,session_hash,config_revision,callback,expires_at) VALUES(%s,%s,%s,%s,%s,%s,clock_timestamp()+interval '10 minutes')",
            (
                digest(state),
                digest(nonce),
                who.id,
                who.token_hash,
                config["revision"] if config else None,
                callback,
            ),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action) VALUES(%s,'deployment.oauth_started')", (who.id,)
        )
    response = RedirectResponse(
        "https://github.com/login/oauth/authorize?"
        + urlencode(
            {
                "client_id": settings.deployment_github_client_id,
                "redirect_uri": callback,
                "scope": "repo workflow",
                "state": state,
            }
        ),
        status_code=303,
    )
    response.set_cookie(
        cookie_name, nonce, path=callback_path, httponly=True, secure=True, samesite="lax", max_age=600
    )
    return response


def oauth_json(url, body=None, token=None):
    headers = {
        "Accept": "application/json",
        "User-Agent": "AlcorApi-release",
        "Content-Type": "application/json",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        url, headers=headers, data=json.dumps(body).encode() if body is not None else None
    )

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    with urllib.request.build_opener(NoRedirect).open(req, timeout=4) as response:
        data = response.read(65537)
    if len(data) > 65536:
        raise ValueError("response budget")
    return json.loads(data)


async def lock_oauth_owner(conn, row, clients=("new-web",)):
    owner = await (
        await conn.execute(
            """SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=%s AND u.id=%s AND u.role='admin' AND u.active AND s.session_version=u.session_version
      AND s.client_id=ANY(%s) AND s.expires_at>clock_timestamp() FOR SHARE OF s,u""",
            (row["session_hash"], row["owner_id"], list(clients)),
        )
    ).fetchone()
    if not owner:
        raise HTTPException(403, "授权会话已失效")


@router.get("/github/callback", include_in_schema=False)
async def oauth_callback(
    request: Request, state: str = Query("", max_length=128), code: str = Query("", max_length=512)
):
    return await oauth_callback_for(
        request, state, code, session_hash=digest(request.cookies.get(SESSION_COOKIE, ""))
    )


async def oauth_callback_for(
    request,
    state,
    code,
    *,
    callback_path=CALLBACK,
    cookie_name=COOKIE,
    clients=("new-web",),
    session_hash=None,
):
    settings, db = request.app.state.settings, request.app.state.db

    def redirect(error=None):
        response = RedirectResponse(
            "/deploy-status?" + urlencode({"github_error": error} if error else {"github": "connected"}),
            status_code=303,
        )
        response.delete_cookie(cookie_name, path=callback_path, secure=True, httponly=True, samesite="lax")
        return response

    row = None
    try:
        callback = callback_url(settings, callback_path)
        if not state or not code or not request.cookies.get(cookie_name):
            raise HTTPException(403, "授权校验失败，请重新开始")
        async with db.connection() as conn, conn.transaction():
            row = await (
                await conn.execute(
                    "SELECT * FROM deployment_oauth_states WHERE state_hash=%s AND expires_at>clock_timestamp() AND consumed_at IS NULL FOR UPDATE",
                    (digest(state),),
                )
            ).fetchone()
            if (
                not row
                or not secrets.compare_digest(row["cookie_hash"], digest(request.cookies[cookie_name]))
                or row["callback"] != callback
                or (session_hash is not None and row["session_hash"] != session_hash)
            ):
                raise HTTPException(403, "授权校验失败，请重新开始")
            await lock_oauth_owner(conn, row, clients)
            await conn.execute(
                "UPDATE deployment_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=%s",
                (row["state_hash"],),
            )
        if not settings.deployment_github_client_id or not settings.deployment_github_client_secret:
            raise HTTPException(503, "GitHub OAuth App 尚未配置")
        result = await asyncio.to_thread(
            oauth_json,
            "https://github.com/login/oauth/access_token",
            {
                "client_id": settings.deployment_github_client_id,
                "client_secret": settings.deployment_github_client_secret.get_secret_value(),
                "redirect_uri": callback,
                "code": code,
            },
        )
        token = result.get("access_token", "")
        if not isinstance(token, str) or not 10 <= len(token) <= 512:
            raise ValueError("token missing")
        user = await asyncio.to_thread(oauth_json, "https://api.github.com/user", None, token)
        account = user.get("login", "")
        if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", account):
            raise ValueError("account invalid")
        encrypted = Vault(settings.connection_secret_dir).encrypt(token, "deployment", settings.instance_id)
        async with db.connection() as conn, conn.transaction():
            await lock_oauth_owner(conn, row, clients)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('alcor.deployment',0))")
            current = await (
                await conn.execute("SELECT * FROM deployment_configuration WHERE singleton FOR UPDATE")
            ).fetchone()
            if (current["revision"] if current else None) != row["config_revision"]:
                raise HTTPException(409, "配置已变化，请重新授权")
            repository = current["repository"] if current else settings.deployment_repository
            if not repository:
                raise HTTPException(409, "请先保存仓库后再授权")
            await conn.execute(
                "INSERT INTO deployment_configuration(singleton,repository,oauth_ciphertext,github_account) VALUES(true,%s,%s,%s) ON CONFLICT(singleton) DO UPDATE SET oauth_ciphertext=excluded.oauth_ciphertext,github_account=excluded.github_account,revision=gen_random_uuid(),updated_at=clock_timestamp()",
                (repository, encrypted, account),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action) VALUES(%s,'deployment.oauth_connected')",
                (row["owner_id"],),
            )
        return redirect()
    except HTTPException as exc:
        return redirect(str(exc.detail))
    except (OSError, ValueError, KeyError, TypeError):
        return redirect("GitHub 授权未完成，请重新核对")


@router.get("/config/receipts/{request_id}")
async def config_receipt(request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT result FROM deployment_config_actions WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此保存请求")
    return row["result"]


async def guard_generation(conn, settings):
    row = await (
        await conn.execute("SELECT revision FROM deployment_configuration WHERE singleton FOR SHARE")
    ).fetchone()
    if (row["revision"] if row else None) != settings.deployment_config_revision:
        raise HTTPException(409, "发布配置已变化，请重新核对")
