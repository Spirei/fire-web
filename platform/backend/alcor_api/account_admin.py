"""Account administration and self password changes with durable versioned receipts."""

import asyncio
import base64
import hashlib
import json
import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, SecretStr, field_validator

from .account_action_receipts import projected_account_receipt, require_open
from .account_action_receipts import router as account_receipts_router
from .account_closure import router as account_closure_router
from .account_credentials import change_own_password
from .admin_audit import audit_admin_rejection
from .client_auth import recent
from .connections import canonical
from .legacy_admin_route import AccountAdminRoute
from .models import InputModel
from .security import COOKIE, Identity, administrator, identity, lock_mutation_identity

router = APIRouter(prefix="/api", tags=["accounts"], route_class=AccountAdminRoute)
Admin = Annotated[Identity, Depends(administrator)]
Member = Annotated[Identity, Depends(identity)]
FIELDS = "id,uid,is_test,username,role,active,revision,created_at"


class ManagedUser(BaseModel):
    id: str
    username: str
    uid: str | None
    is_test: bool
    role: Literal["admin", "user"]
    active: bool
    revision: UUID
    created_at: datetime


class OwnAccount(ManagedUser):
    email: str
    two_factor_enabled: bool = False


class DirectoryUser(ManagedUser):
    email: str
    display_name: str
    avatar_revision: UUID | None = None
    two_factor_enabled: bool = False
    records_count: int | None = None


class UsersOut(BaseModel):
    items: list[DirectoryUser]
    next_cursor: str | None


class UserChange(InputModel):
    request_id: UUID
    revision: UUID
    # Omitted patch fields are preserved by the locked CAS transaction. The
    # missing-only sentinel is not an accepted explicit null or a role default.
    role: Literal["admin", "user"] = Field(default_factory=lambda: None)
    active: bool = Field(default_factory=lambda: None, strict=True)
    username: str = Field(default_factory=str)
    email: str = Field(default_factory=str)
    current_password: SecretStr | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(default="", max_length=64)

    @field_validator("current_password")
    @classmethod
    def valid_control_password(cls, value):
        if value is not None:
            value.get_secret_value().encode("utf-8")
        return value

    @field_validator("username")
    @classmethod
    def managed_username(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}", value.strip()):
            raise ValueError("用户名需为3-20位字母、数字、下划线或中文")
        return value.strip()

    @field_validator("email")
    @classmethod
    def managed_email(cls, value):
        from .identity_email_change import email_value

        if not isinstance(value, str):
            raise ValueError("邮箱必须为文字")  # noqa: TRY004 -- Pydantic converts ValueError, not TypeError, into a 422 response.
        value.encode("utf-8")
        try:
            return email_value(value)
        except HTTPException:
            raise ValueError("邮箱格式不正确") from None


class PasswordChange(InputModel):
    code: str = Field(default="", max_length=32)
    current_password: SecretStr = Field(min_length=1, max_length=128)
    new_password: SecretStr = Field(min_length=8, max_length=128)

    @field_validator("current_password", "new_password")
    @classmethod
    def unicode_password(cls, value):
        value.get_secret_value().encode("utf-8")
        return value


class ManagedCredentials(InputModel):
    request_id: UUID
    revision: UUID
    current_password: SecretStr = Field(min_length=1, max_length=128)
    code: str = Field(default="", max_length=64)
    # The shared password validator measures UTF-16 units like the old clients.
    new_password: SecretStr | None = Field(default=None, max_length=128)

    @field_validator("current_password", "new_password")
    @classmethod
    def valid_unicode(cls, value):
        if value is not None:
            value.get_secret_value().encode("utf-8")
        return value


async def credential_action(user_id, data, request, who, action):
    from .admin_credentials import recover_credentials

    for key, limit in (("admin-credentials:" + who.id, 10), ("admin-credentials-global", 50)):
        if not await request.app.state.rate_limit(request.app.state.db, key, limit, window_seconds=900):
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
    return await recover_credentials(request.app.state.db, who, user_id, data, action)


@router.post("/users/{user_id}/reset-password")
@audit_admin_rejection("admin.password_reset_rejected")
async def reset_managed_password(user_id: str, data: ManagedCredentials, request: Request, who: Admin):
    return await credential_action(user_id, data, request, who, "reset-password")


@router.post("/users/{user_id}/disable-totp")
@audit_admin_rejection("auth.totp.admin_disable_rejected")
async def disable_managed_totp(user_id: str, data: ManagedCredentials, request: Request, who: Admin):
    return await credential_action(user_id, data, request, who, "disable-totp")


@router.get("/account", response_model=OwnAccount)
async def own_account(request: Request, who: Member):
    async with request.app.state.db.connection() as conn:
        return await (
            await conn.execute(
                "SELECT "
                + FIELDS
                + ",email,COALESCE((SELECT totp_enabled FROM identity_security WHERE user_id=users.id),false) AS two_factor_enabled FROM users WHERE id=%s",
                (who.id,),
            )
        ).fetchone()


@router.post("/account/password", status_code=204)
async def change_password(data: PasswordChange, request: Request, who: Member):
    db = request.app.state.db
    if not await request.app.state.rate_limit(db, "change-password:" + who.id, 10):
        raise HTTPException(429, "操作过于频繁，请稍后再试")
    await change_own_password(
        db,
        who,
        data.current_password.get_secret_value(),
        data.new_password.get_secret_value(),
        data.code,
        request.state.request_id,
    )
    response = Response(status_code=204)
    response.delete_cookie(
        COOKIE, path="/", httponly=True, secure=request.app.state.settings.secure_cookie, samesite="lax"
    )
    return response


@router.get("/users", response_model=UsersOut)
async def users(
    request: Request,
    who: Admin,
    q: str = Query(default="", max_length=80),
    cursor: str | None = Query(default=None, max_length=512),
    limit: int = Query(default=20, ge=1, le=100),
):
    return await user_directory(request.app.state.db, who, q=q, cursor=cursor, limit=limit)


async def user_directory(db, who, *, q="", cursor=None, limit=20, project=None):
    conditions = ["u.deleted_at IS NULL", "(u.username ILIKE %s OR u.uid ILIKE %s)"]
    args = ["%" + q + "%", "%" + q + "%"]
    if cursor:
        try:
            test, number, ident = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
            if type(test) is not bool or not isinstance(ident, str) or len(ident) > 100:
                raise ValueError()
            if (test and number is not None) or (
                not test and (not isinstance(number, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", number))
            ):
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(422, "分页标记无效") from None
        conditions.append("(u.is_test,COALESCE(u.uid::numeric,0),u.id)>(%s,%s::numeric,%s)")
        args.extend([test, number or "0", ident])
    args.append(limit + 1)
    async with db.connection() as conn, conn.transaction():
        await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        await lock_mutation_identity(conn, who)
        rows = await (
            await conn.execute(
                """SELECT u.id,u.username,u.role,u.active,u.revision,u.created_at,u.email,
                COALESCE(NULLIF(p.display_name,''),NULLIF(left(m.metadata->>'nickname',80),''),u.username) AS display_name,
                u.uid AS uid,u.is_test,CASE WHEN p.avatar IS NOT NULL OR p.avatar_object_id IS NOT NULL THEN p.revision END AS avatar_revision,
                COALESCE(s.totp_enabled,false) AS two_factor_enabled,NULL::integer AS records_count
                FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id
                LEFT JOIN identity_source_profiles m ON m.user_id=u.id
                LEFT JOIN identity_security s ON s.user_id=u.id WHERE """
                + " AND ".join(conditions)
                + " ORDER BY u.is_test,COALESCE(u.uid::numeric,0),u.id LIMIT %s",
                args,
            )
        ).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = (
            base64.urlsafe_b64encode(json.dumps([rows[-1]["is_test"], rows[-1]["uid"], rows[-1]["id"]]).encode())
            .decode()
            .rstrip("=")
            if more
            else None
        )
        page = {"items": rows, "next_cursor": next_cursor}
        return await project(conn, page) if project else page


@router.get("/users/{user_id}/avatar")
async def directory_avatar(user_id: str, revision: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT avatar,avatar_object_id FROM user_profiles WHERE user_id=%s AND revision=%s",
                (user_id, revision),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "头像不存在或已更新")
        if row["avatar_object_id"]:
            from .profile_media import ProfileMedia

            raw, kind = await ProfileMedia(request.app.state.db.settings).read(
                conn, user_id, row["avatar_object_id"]
            )
        elif row["avatar"]:
            raw, kind = bytes(row["avatar"]), "image/jpeg"
        else:
            raise HTTPException(404, "头像不存在或已更新")
    return Response(
        content=raw,
        media_type=kind,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.patch("/users/{user_id}")
@audit_admin_rejection("admin.account_update_rejected")
async def update_user(user_id: str, data: UserChange, request: Request, who: Admin):
    payload = data.model_dump(mode="json", exclude={"request_id", "current_password", "code"}, exclude_unset=True) | {"user_id": user_id}
    fingerprint = hashlib.sha256(canonical(payload).encode()).hexdigest()
    async with request.app.state.db.connection() as conn, conn.transaction():
        # Serialize privilege changes before holding any user row lock, including the actor's own row.
        await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
        for identifier in sorted({who.id, user_id}):
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + identifier,)
            )
        await conn.execute("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
        await lock_mutation_identity(conn, who)
        previous = await (
            await conn.execute(
                "SELECT * FROM account_actions WHERE owner_id=%s AND request_id=%s", (who.id, data.request_id)
            )
        ).fetchone()
        if previous:
            require_open(previous)
            if previous["fingerprint"] != fingerprint:
                raise HTTPException(409, "请求编号已用于其他操作")
            return await projected_account_receipt(conn, previous["result"])
        row = await (
            await conn.execute("SELECT " + FIELDS + ",email FROM users WHERE id=%s FOR UPDATE", (user_id,))
        ).fetchone()
        if not row:
            raise HTTPException(404, "账号不存在")
        if (await (await conn.execute("SELECT deleted_at FROM users WHERE id=%s", (user_id,))).fetchone())[
            "deleted_at"
        ]:
            raise HTTPException(409, "账号已删除")
        if row["revision"] != data.revision:
            raise HTTPException(409, "账号已更新，请重新读取")
        role = data.role if "role" in data.model_fields_set else row["role"]
        active = data.active if "active" in data.model_fields_set else row["active"]
        if row["active"] and row["role"] == "admin" and (not active or role != "admin"):
            count = (
                await (
                    await conn.execute("SELECT count(*) AS n FROM users WHERE active AND role='admin'")
                ).fetchone()
            )["n"]
            if count <= 1:
                raise HTTPException(409, "须保留至少一个可用管理员")
        if (getattr(who, "require_admin_step_up", False) or data.current_password is not None
                or row["role"] != role or row["active"] != active):
            await managed_step_up(request, conn, who, data)
        else:
            await recent(conn, who)
        username = data.username if "username" in data.model_fields_set else row["username"]
        email = data.email if "email" in data.model_fields_set else row["email"]
        for login in (username, email):
            if (
                login
                and await (
                    await conn.execute(
                        "SELECT 1 FROM users WHERE id<>%s AND (lower(username)=lower(%s) OR (email<>'' AND lower(email)=lower(%s)))",
                        (user_id, login, login),
                    )
                ).fetchone()
            ):
                raise HTTPException(409, "用户名或邮箱已被使用")
        if email != row["email"]:
            from types import SimpleNamespace

            from .identity_email_change import IdentityEmailChange

            writer = IdentityEmailChange(
                request.app.state.settings, request.app.state.db, request.app.state.identity_email.mail
            )
            await writer.apply(
                conn,
                SimpleNamespace(id=user_id),
                row,
                email,
                data.request_id,
                revoke=False,
                audit_actor_id=who.id,
            )
        changed = (
            row["role"] != role
            or row["active"] != active
            or username != row["username"]
            or email != row["email"]
        )
        if changed:
            row = await (
                await conn.execute(
                    "UPDATE users SET role=%s,active=%s,username=%s,session_version=session_version+1,revision=%s WHERE id=%s RETURNING "
                    + FIELDS
                    + ",email",
                    (role, active, username, uuid4(), user_id),
                )
            ).fetchone()
            await conn.execute("DELETE FROM sessions WHERE user_id=%s", (user_id,))
            from .broker_position_transfers import purge_broker_position_transfer_previews
            await purge_broker_position_transfer_previews(conn, user_id)
            from .fund_sources import purge_fund_source_previews
            await purge_fund_source_previews(conn, user_id)
            from .legacy_record_writes import purge_record_batch_previews
            await purge_record_batch_previews(conn, user_id)
            await conn.execute(
                "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=%s",
                (user_id,),
            )
            await conn.execute(
                "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=%s",
                (user_id,),
            )
        from .legacy_identity import public_profile

        # Persist the public profile observed by this same account transaction.
        # Protocol adapters must not substitute a later target profile on replay.
        profile_snapshot = await public_profile(conn, user_id)
        result = {"request_id": str(data.request_id), "user": jsonable_encoder(row), "changed": changed, "profile": profile_snapshot}
        await conn.execute(
            "INSERT INTO account_actions(owner_id,request_id,fingerprint,result) VALUES (%s,%s,%s,%s)",
            (who.id, data.request_id, fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES (%s,'account.updated',%s,%s)",
            (who.id, user_id, data.request_id),
        )
    return result


@router.get("/users/receipts/{request_id}")
async def action_receipt(request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        row = await (
            await conn.execute(
                "SELECT result FROM account_actions WHERE owner_id=%s AND request_id=%s", (who.id, request_id)
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "未查到此请求的回执")
        return await projected_account_receipt(conn, row["result"])


class AccountRemoval(InputModel):
    request_id: UUID
    revision: UUID
    current_password: SecretStr | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(default="", max_length=64)

    @field_validator("current_password")
    @classmethod
    def valid_control_password(cls, value):
        if value is not None:
            value.get_secret_value().encode("utf-8")
        return value


class AccountClosure(AccountRemoval):
    receipt_token: SecretStr | None = Field(default=None, min_length=47, max_length=47)

    @field_validator("receipt_token")
    @classmethod
    def valid_closure_receipt_token(cls, value):
        if value is not None and not re.fullmatch(r"acr_[A-Za-z0-9_-]{43}", value.get_secret_value()):
            raise ValueError("invalid_closure_receipt_token")
        return value

    current_password: SecretStr = Field(min_length=1, max_length=128)
    code: str = Field(default="", max_length=32)


async def managed_step_up(request, conn, who, data):
    from .identity_passkeys import Passkeys
    from .identity_service import IdentityService

    db = request.app.state.db
    for key, maximum in (("admin-account-control:" + who.id, 10), ("admin-account-control-global", 50)):
        if not await request.app.state.rate_limit(db, key, maximum, window_seconds=900):
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
    if data.current_password is None:
        raise HTTPException(403, "请核对当前管理员密码")
    factors = IdentityService(db.settings, db)
    await Passkeys(db.settings, db, factors).step_up(
        conn, who, data.current_password.get_secret_value(), data.code
    )


async def retire_account(conn, who, user_id, data, request_id, *, self_close=False, authorize=None):
    fingerprint = hashlib.sha256(
        canonical(
            {"action": "close" if self_close else "delete", "target": user_id, "revision": str(data.revision)}
        ).encode()
    ).hexdigest()
    previous = await (
        await conn.execute(
            "SELECT * FROM account_actions WHERE owner_id=%s AND request_id=%s", (who.id, data.request_id)
        )
    ).fetchone()
    if previous:
        require_open(previous)
        if previous["fingerprint"] != fingerprint:
            raise HTTPException(409, "请求编号已用于其他操作")
        return previous["result"]
    if self_close and getattr(data, "receipt_token", None) is None:
        marker = await (await conn.execute("SELECT 1 FROM schema_migrations WHERE name='0090_account_closure_receipts.sql'")).fetchone()
        if marker and await (await conn.execute("SELECT 1 FROM account_closure_intents WHERE owner_id=%s AND request_id=%s", (who.id, data.request_id))).fetchone():
            raise HTTPException(409, "原注销编号已准备，请使用其原查询凭证")
    target = await (await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (user_id,))).fetchone()
    if not target or target["deleted_at"]:
        raise HTTPException(404, "账号不存在")
    if target["revision"] != data.revision:
        raise HTTPException(409, "账号已更新，请重新读取")
    if not self_close and user_id == who.id:
        raise HTTPException(403, "管理员须在设置中注销本人账号")
    if target["role"] == "admin" and target["active"]:
        count = (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM users WHERE active AND role='admin' AND deleted_at IS NULL"
                )
            ).fetchone()
        )["n"]
        if count <= 1:
            raise HTTPException(409, "须先设置另一位可用管理员，再注销本人账号")
    if not self_close:
        if authorize is None:
            raise HTTPException(403, "请核对当前管理员身份")
        await authorize()
    await conn.execute(
        "UPDATE users SET active=false,password_hash='',email='',deleted_at=clock_timestamp(),session_version=session_version+1,revision=%s WHERE id=%s",
        (uuid4(), user_id),
    )
    await conn.execute("DELETE FROM sessions WHERE user_id=%s", (user_id,))
    await conn.execute(
        "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=%s",
        (user_id,),
    )
    await conn.execute(
        "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=%s",
        (user_id,),
    )
    await conn.execute("DELETE FROM identity_challenges WHERE user_id=%s", (user_id,))
    await conn.execute("DELETE FROM identity_passkeys WHERE user_id=%s", (user_id,))
    await conn.execute("DELETE FROM identity_security WHERE user_id=%s", (user_id,))
    await conn.execute("DELETE FROM user_profiles WHERE user_id=%s", (user_id,))
    await conn.execute("DELETE FROM profile_operation_receipts WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM profile_media_objects WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM resource_operation_receipts WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM resource_files WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM resource_folders WHERE owner_id=%s", (user_id,))
    for table in ("personal_font_source_aliases", "personal_font_source_captures", "personal_font_source_permissions", "personal_font_source_operations"):
        await conn.execute("DELETE FROM " + table + " WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM personal_font_operations WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM personal_fonts WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM personal_font_scopes WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM watch_group_source_icon_links WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM watch_group_source_icon_captures WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM watch_group_icon_versions WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM resource_media_objects WHERE owner_id=%s", (user_id,))
    await conn.execute("DELETE FROM account_preferences WHERE user_id=%s", (user_id,))
    history_installed = (await (await conn.execute(
        "SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0150_fire_web_preferences.sql') AS installed"
    )).fetchone())["installed"]
    for table in ("user_search_history", "user_search_history_state"):
        if history_installed:
            await conn.execute("DELETE FROM public." + table + " WHERE user_id=%s", (user_id,))
        elif (await (await conn.execute("SELECT to_regclass(%s) AS relation", ("public." + table,))).fetchone())["relation"] is not None:
            raise HTTPException(503, "搜索历史结构与迁移记录不一致，请先核对")
    from .card_catalog import purge_owner as purge_card_catalog_owner

    await purge_card_catalog_owner(conn, user_id)
    from .card_wallet import purge_wallet_private

    await purge_wallet_private(conn, user_id)
    from .broker_metadata import purge_broker_metadata_previews

    await purge_broker_metadata_previews(conn, user_id)
    from .broker_bindings import purge_broker_binding_previews
    await purge_broker_binding_previews(conn, user_id)
    from .broker_statements import purge_broker_statement_previews
    await purge_broker_statement_previews(conn, user_id)
    from .broker_position_transfers import purge_broker_position_transfer_previews
    await purge_broker_position_transfer_previews(conn, user_id)
    from .fund_sources import purge_fund_source_previews
    await purge_fund_source_previews(conn, user_id)
    from .legacy_record_writes import purge_record_batch_previews
    await purge_record_batch_previews(conn, user_id)
    # Historical restore/upgrade validation can close an account before this
    # feature's migration. Only the proven pre-feature schema skips cleanup;
    # permissions, damaged current schemas and every other DB error still abort.
    cards_installed = await (
        await conn.execute(
            "SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0080_card_preferences.sql') AS installed"
        )
    ).fetchone()
    for table in (
        "card_preference_operations",
        "card_preference_tags",
        "card_preference_holdings",
        "card_preference_collections",
    ):
        if cards_installed["installed"]:
            await conn.execute("DELETE FROM public." + table + " WHERE owner_id=%s", (user_id,))
        else:
            relation = await (
                await conn.execute("SELECT to_regclass(%s) AS relation", ("public." + table,))
            ).fetchone()
            if relation["relation"] is not None:
                raise HTTPException(503, "卡包偏好结构与迁移记录不一致，请先核对")
    await conn.execute(
        "UPDATE identity_source_profiles SET metadata=jsonb_build_object('uid',%s::text) WHERE user_id=%s",
        (target["uid"], user_id),
    )
    result = {"request_id": str(data.request_id), "user_id": user_id, "deleted": True}
    await conn.execute(
        "INSERT INTO account_actions(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
        (who.id, data.request_id, fingerprint, Jsonb(result)),
    )
    await conn.execute(
        "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
        (who.id, "account.closed" if self_close else "account.deleted", user_id, request_id),
    )
    return result


@router.delete("/users/{user_id}")
@audit_admin_rejection("admin.user_delete_rejected")
async def delete_user(user_id: str, data: AccountRemoval, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
        for identifier in sorted({who.id, user_id}):
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + identifier,)
            )
        await lock_mutation_identity(conn, who)

        async def authorize():
            await managed_step_up(request, conn, who, data)

        return await retire_account(conn, who, user_id, data, request.state.request_id, authorize=authorize)


@router.post("/account/close")
async def close_account(data: AccountClosure, request: Request, who: Member):
    from .legacy_admin_route import protocol_body

    await protocol_body(request, 4096)
    if data.receipt_token is not None:
        from .account_closure import finalize

        result = await finalize(data, request, who)
        response = Response(
            content=json.dumps(result), media_type="application/json", headers={"Cache-Control": "no-store"}
        )
        response.delete_cookie(
            COOKIE,
            path="/",
            httponly=True,
            secure=request.app.state.db.settings.secure_cookie,
            samesite="lax",
        )
        return response
    # The previous administrator-only command remains supported; ordinary members
    # must prepare and retain their dedicated closure capability before confirmation.
    if who.role != "admin":
        raise HTTPException(403, "请先准备原注销请求")
    return await close_admin_compat(data, request, who)


async def close_admin_compat(data: AccountClosure, request: Request, who: Identity):
    from .identity_service import IdentityService
    from .passwords import verify_password

    db = request.app.state.db
    if not await request.app.state.rate_limit(db, "account-close:" + who.id, 5):
        raise HTTPException(429, "操作过于频繁，请稍后再试")
    async with db.connection() as conn:
        original = await (
            await conn.execute("SELECT password_hash FROM users WHERE id=%s", (who.id,))
        ).fetchone()
    if not original or not await asyncio.to_thread(
        verify_password, data.current_password.get_secret_value(), original["password_hash"]
    ):
        raise HTTPException(422, "当前密码不正确")
    async with db.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
        await request.app.state.native_passkeys.serialize(conn, who)
        await lock_mutation_identity(conn, who)
        current = await (
            await conn.execute("SELECT password_hash FROM users WHERE id=%s FOR UPDATE", (who.id,))
        ).fetchone()
        if current["password_hash"] != original["password_hash"]:
            raise HTTPException(409, "账号已更新，请重新核对")
        service = IdentityService(db.settings, db)
        factor = await service.factor(conn, who.id)
        if factor and factor["totp_enabled"] and not await service.consume(conn, who.id, data.code):
            raise HTTPException(403, "二次验证失败")
        result = await retire_account(conn, who, who.id, data, request.state.request_id, self_close=True)
    response = Response(content=json.dumps(result), media_type="application/json")
    response.delete_cookie(COOKIE, path="/", httponly=True, secure=db.settings.secure_cookie, samesite="lax")
    return response


router.include_router(account_receipts_router)


router.include_router(account_closure_router)


@router.put("/users/{user_id}")
async def legacy_put_user(user_id: str, request: Request, who: Admin):
    raise HTTPException(405, "请使用当前平台的账号更新入口")
