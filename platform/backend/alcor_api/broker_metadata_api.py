"""Explicit Web/App directory negotiation; does not advertise the old full broker contract."""

import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .broker_accounts import CURRENCIES
from .broker_metadata import BrokerMetadata
from .legacy_broker_read import PRESETS
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest, identity


def discovery(*, native=False):
    root = "/api/client/broker-metadata" if native else "/api/account/broker-metadata"
    return {
        "version": 1,
        "supported": True,
        "state_path": root,
        "preview_path": root + "/preview",
        "submit_path": root + "/operations",
        "operation_path": root + "/operations/{requestId}",
        "close_path": root + "/operations/{requestId}/close",
        "supported_operations": ["create", "update", "delete"],
        "read_scope": "portfolio.read" if native else "new-web-owner",
        "write_scope": "portfolio.write" if native else "new-web-owner",
        "preview_required": True,
        "automatic_mutation_replay": False,
        "explicit_account_kind_required": True,
        "account_kinds": ["real", "simulated"],
        "unknown_account_kind_readable": True,
        "coverage_scope": "platform_owned_directory",
        "historical_coverage_known": False,
        "financial_writes": False,
        "record_binding": False,
        "owned_icon_upload": True,
        "statement_connections": False,
        "legacy_broker_accounts_contract": False,
    }


def directory_discovery(version):
    from .broker_bindings_api import discovery as binding_discovery
    from .broker_holding_source_api import discovery as source_discovery
    from .broker_icons_api import discovery as icon_discovery
    from .broker_position_transfer_api import discovery as transfer_discovery
    from .broker_statement_discovery import discovery as statement_discovery
    base = f"/api/v{version}/broker-accounts"
    return {
        "version": 1,
        "accounts_path": base,
        "account_path": base + "/{accountId}",
        "presets_path": base + "/presets",
        "read_scope": "portfolio.read",
        "explicit_account_kind": True,
        "coverage_scope": "platform-only",
        "historical_coverage_known": False,
        "metadata_management": discovery(native=True),
        "statements": statement_discovery(native=True),
        "icons": icon_discovery(native=True),
        "holding_source": source_discovery(native=True),
        "bindings": binding_discovery(native=True),
        "position_transfers": transfer_discovery(native=True),
        "cash": {
            "account_path": base + "/{accountId}/cash",
            "entries_path": base + "/{accountId}/cash/entries",
            "coverage_scope": "platform-registered-only",
            "running_balances": False,
            "withdrawal_capacity": False,
            "ledger_withdrawal_capacity": True,
            "ledger_capacity_scope": "platform_owner_kind_cash",
            "write_supported": False,
        },
        "full_legacy_contract": False,
    }


def mount_broker_metadata(app, rate_limit):
    service = BrokerMetadata(app.state.db)
    app.state.broker_metadata = service
    mount_owned_metadata(
        app,
        rate_limit,
        service,
        namespace="broker-metadata",
        capabilities=discovery,
        extra_state={"presets": PRESETS},
        body_limit=16384,
    )


def mount_owned_metadata(
    app, rate_limit, service, *, namespace, capabilities, extra_state=None, body_limit=16384, state_query=None
):

    async def member(request, native):
        if request.query_params and not (state_query is not None and request.method == "GET" and request.url.path in ("/api/account/" + namespace, "/api/client/" + namespace)):
            raise HTTPException(400, "不支持查询参数")
        if native:
            assert_native_origin(request, app.state.db.settings)
            who, grant = await native_identity(
                request, app.state.db, "portfolio.read" if request.method == "GET" else "portfolio.write"
            )
            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "连接已失效")
        else:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            who = await identity(request)
        if request.method != "GET" and not await rate_limit(
            app.state.db, digest(namespace + ":" + who.id), 60, window_seconds=60
        ):
            raise HTTPException(429, "操作过于频繁")
        return who

    async def body(request):
        def reject_constant(_):
            raise ValueError()

        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result

        try:
            return json.loads(
                await bounded_body(request, body_limit),
                parse_constant=reject_constant,
                object_pairs_hook=pairs,
            )
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, "账户请求格式无效") from None

    async def execute(request, action, request_id=None):
        native = request.url.path.startswith("/api/client/")
        headers = {
            "Cache-Control": "no-store, private",
            "Vary": "Authorization" if native else "Cookie",
            "X-Alcor-Source-Coverage": "platform-only",
        }
        try:
            who = await member(request, native)
            if action == "state":
                result = {
                    **await service.state(who, **(state_query(request.query_params) if state_query is not None else {})),
                    "capabilities": {**capabilities(native=native), "supported_currencies": list(CURRENCIES)},
                    **(extra_state or {}),
                }
            elif action == "preview":
                result = await service.preview(who, await body(request))
            elif action == "submit":
                result = await service.submit(who, await body(request))
            elif action == "receipt":
                result = await service.receipt(who, request_id)
            else:
                if (await bounded_body(request, 128)).strip() not in (b"", b"{}"):
                    raise HTTPException(422, "关闭请求字段无效")
                result = await service.close(who, request_id)
            return JSONResponse(result, headers=headers)
        except HTTPException as exc:
            for key, value in (exc.headers or {}).items():
                if key.lower() in {"x-alcor-session-changed", "x-alcor-reauthentication", "retry-after"}:
                    headers[key] = value
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse(
                {"error": {"code": exc.status_code * 100 + 1, "message": str(exc.detail)}},
                status_code=exc.status_code,
                headers=headers,
            )

    @app.get("/api/account/" + namespace + "")
    @app.get("/api/client/" + namespace + "")
    async def state(request: Request):
        return await execute(request, "state")

    @app.post("/api/account/" + namespace + "/preview")
    @app.post("/api/client/" + namespace + "/preview")
    async def preview(request: Request):
        return await execute(request, "preview")

    @app.post("/api/account/" + namespace + "/operations")
    @app.post("/api/client/" + namespace + "/operations")
    async def submit(request: Request):
        return await execute(request, "submit")

    @app.get("/api/account/" + namespace + "/operations/{request_id}")
    @app.get("/api/client/" + namespace + "/operations/{request_id}")
    async def receipt(request_id: UUID, request: Request):
        return await execute(request, "receipt", request_id)

    @app.post("/api/account/" + namespace + "/operations/{request_id}/close")
    @app.post("/api/client/" + namespace + "/operations/{request_id}/close")
    async def close(request_id: UUID, request: Request):
        return await execute(request, "close", request_id)
