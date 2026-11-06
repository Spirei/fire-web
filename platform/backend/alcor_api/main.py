import contextlib
from .profile_http import body_budget, profile_limits
from .fee_http import fee_body_budget
from .legacy_profile_api import mount_profile_compatibility
from .personal_profile_api import mount_personal_profiles
from .native_profile import mount_native_profile
import re
from .legacy_identity import LEGACY_WEB_PATHS, mount_legacy_identity
from .identity_service import IdentityService
from .identity_api import FactorChallengeOut, mount_identity_routes
import asyncio
import json
import logging
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from psycopg.errors import UniqueViolation

from . import __build__, __version__, profiles, tasks
from .account_preferences import router as account_preferences_router
from .accounts import registration_status
from .registration import register_account
from .migration_catalog import build_capability_plan
from .migration_work_status import read_work_status
from .config import Settings
from .connections import CacheHandle, Connections, bootstrap_settings
from .connection_models import ConnectionInput, ConnectionReceiptOut, ConnectionSettingsOut, Kind
from .db import Database
from .models import ActivityOut, LoginInput, OverviewOut, ProfileInput, ProfileOut, RegisterInput, RegistrationOut, SessionOut, TaskDetail, TaskInput, TaskList, TaskOut, TaskStatus
from .passwords import DUMMY_HASH, verify_password
from .security import COOKIE, Identity, administrator, csrf_token, digest, identity, trusted_origin

log = logging.getLogger("alcor.api")
Admin = Annotated[Identity, Depends(administrator)]
Member = Annotated[Identity, Depends(identity)]
PREFIX = "/api"


async def rate_limit(db, key, maximum, *, window_seconds=900):
    if not isinstance(window_seconds, int) or not 1 <= window_seconds <= 86400:
        raise ValueError('Invalid authentication budget window')
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                """
            WITH attempt AS (SELECT clock_timestamp() AS at)
            INSERT INTO auth_rate_limits (bucket,window_start,attempts) SELECT %s,at,1 FROM attempt
            ON CONFLICT (bucket) DO UPDATE SET
              attempts=CASE WHEN auth_rate_limits.window_start<excluded.window_start-make_interval(secs => %s) THEN 1 ELSE auth_rate_limits.attempts+1 END,
              window_start=CASE WHEN auth_rate_limits.window_start<excluded.window_start-make_interval(secs => %s) THEN excluded.window_start ELSE auth_rate_limits.window_start END
            RETURNING attempts
        """,
                (key,window_seconds,window_seconds),
            )
        ).fetchone()
    return row["attempts"] <= maximum


class BodyBudget:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        used = 0

        async def bounded_receive():
            nonlocal used
            message = await receive()
            used += len(message.get("body", b""))
            path = scope.get("path", "")
            if path in {"/api/settings/model-icon", "/api/admin/provider-operations/model-icon"}:
                budget = 2 * 1024 * 1024 + 65536
            elif path in {"/api/settings", "/api/admin/private-runtime-settings"}:
                budget = 1024 * 1024
            elif path == "/api/clipboard":
                budget = 12 * 1024 * 1024 + 65536
            elif path == "/api/account/card-recognition/operations":
                budget = 8 * 1024 * 1024 + 65536
            elif path == "/api/app-packages":
                budget = 2 * 1024**3
            elif path == "/api/celebs":
                budget = 1024 * 1024
            elif path in {"/api/celebs/avatar", "/api/celebs/stock-icon"}:
                budget = 2 * 1024 * 1024 + 65536
            elif path == "/api/celebs/sources/collect":
                budget = 16384
            else:
                budget = max(body_budget(path), fee_body_budget(path))
            if used > budget:
                raise HTTPException(413, "请求过大")
            return message

        await self.app(scope, bounded_receive, send)


def create_app(settings: Settings | None = None):
    settings = settings or Settings()
    runtime, bootstrap_revision = bootstrap_settings(settings)
    db = Database(runtime)
    cache = CacheHandle(settings)
    connections = Connections(settings, db, cache)

    from .request_observability import Observations, ObserveRequests
    observations = Observations(db)
    from .request_activity import CountAccountRequests, RequestActivity, mount_request_activity
    request_activity = RequestActivity(db)

    @asynccontextmanager
    async def lifespan(app):
        await db.open()
        watcher = None
        try:
            await connections.verify_bootstrap(bootstrap_revision)
            watcher = asyncio.create_task(connections.watch())
            observer = asyncio.create_task(observations.loop())
            activity_writer = asyncio.create_task(request_activity.loop())
            yield
        finally:
            if watcher:
                watcher.cancel()
                try:
                    await watcher
                except asyncio.CancelledError:
                    pass
            if "observer" in locals():
                observer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await observer
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(observations.flush(), 3)
            if "activity_writer" in locals():
                activity_writer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await activity_writer
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(request_activity.flush(), 3)
            await cache.aclose()
            await db.close()

    app = FastAPI(
        title="Alcor Platform",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.environment in {"local", "test"} else None,
    )
    app.state.db, app.state.settings, app.state.cache = db, settings, cache
    app.state.connections = connections
    app.state.rate_limit = rate_limit
    app.state.request_observations = observations
    app.state.request_activity = request_activity
    mount_request_activity(app, db)
    app.add_middleware(BodyBudget)

    @app.middleware("http")
    async def security_headers(request, call_next):
        request.state.request_id = str(uuid4())
        cors_origin = None
        if request.url.path in {PREFIX+'/connect/config',PREFIX+'/connect/token',PREFIX+'/connect/revoke',PREFIX+'/connect/profile',PREFIX+'/connect/activity',PREFIX+'/connect/session'}:
            origin = request.headers.get('origin')
            if origin and origin != settings.public_origin:
                from .client_auth import cors_allowed
                try:
                    allowed=await cors_allowed(db,origin)
                except Exception:
                    allowed=False
                if not allowed:
                    return JSONResponse({'error':{'code':'origin_denied','message':'客户端来源未获允许'}},status_code=403,headers={'Cache-Control':'no-store'})
                cors_origin=origin
        if cors_origin and request.method=='OPTIONS':
            response=Response(status_code=204)
        else:
            response = await call_next(request)
        if cors_origin:
            response.headers.update({'Access-Control-Allow-Origin':cors_origin,'Vary':'Origin','Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Max-Age':'300'})
        response.headers.update(
            {
                "X-Request-ID": request.state.request_id,
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer" if request.url.path == "/verify-email" else "same-origin",
                "X-Frame-Options": "DENY",
                "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                "Content-Security-Policy": response.headers.get("Content-Security-Policy") or "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            }
        )
        public_calendar = request.url.path in {"/api/v2/market-calendar", "/api/v2/market-calendar/batch"} and response.status_code in {200,304}
        public_fixed = (
            request.url.path == "/api/system-assets/security-check" and response.status_code == 200
        )
        public_asset_key = bool(re.fullmatch(r"/api/asset-image/[a-f0-9]{24}", request.url.path)) and request.method in {"GET", "HEAD"} and response.status_code in {200, 206, 304, 416}
        if request.url.path.startswith(("/api", "/health")) and not (public_calendar or public_fixed or public_asset_key):
            cache_control = response.headers.get("Cache-Control", "")
            if "no-store" not in {value.strip().lower() for value in cache_control.split(",")}:
                response.headers["Cache-Control"] = "no-store"
        if settings.secure_cookie:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    def error(request, status, code, message):
        if re.match(r'^/api/v[12]/',request.url.path):
            return JSONResponse(status_code=status,content={'code':50001 if status>=500 else 40002,'message':message},headers={'Cache-Control':'no-store','X-Alcor-API-Version':request.url.path[6]})
        if request.url.path in LEGACY_WEB_PATHS:
            return JSONResponse(status_code=status,content={'error':message},headers={'Cache-Control':'no-store'})
        return JSONResponse(
            status_code=status,
            content={
                "error": {"code": code, "message": message},
                "request_id": getattr(request.state, "request_id", None),
            },
            headers={"Cache-Control": "no-store"},
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        if re.match(r'^/api/v[12]/',request.url.path):
            code=getattr(exc,'business_code',{400:40002,401:40101 if '需要有效的 App 连接' in str(exc.detail) else 40102,403:40301,404:40401,409:40901,422:40003,429:42901}.get(exc.status_code,50001))
            return JSONResponse(status_code=exc.status_code,content={'code':code,'message':str(exc.detail)},headers={'Cache-Control':'no-store','X-Alcor-API-Version':request.url.path[6]})
        if request.url.path in LEGACY_WEB_PATHS:
            payload = {'error': str(exc.detail)}
            if exc.headers and exc.headers.get('X-Alcor-Reauthentication') == 'required':
                payload['requiresReauthentication'] = True
            return JSONResponse(status_code=exc.status_code, content=payload, headers={'Cache-Control':'no-store'})
        response=error(request, exc.status_code, f"http_{exc.status_code}", str(exc.detail))
        if exc.headers:response.headers.update(exc.headers)
        return response

    @app.exception_handler(RequestValidationError)
    async def input_error(request, exc):
        if re.match(r'^/api/v[12]/',request.url.path):
            return JSONResponse(status_code=400,content={'code':40002,'message':'请求参数无效'},headers={'Cache-Control':'no-store','X-Alcor-API-Version':request.url.path[6]})
        return error(request, 422, "invalid_input", "输入格式或范围不符合要求")

    @app.exception_handler(Exception)
    async def unexpected(request, exc):
        log.warning(
            "request_failed type=%s request_id=%s",
            type(exc).__name__,
            getattr(request.state, "request_id", ""),
        )
        return error(request, 503, "service_unavailable", "服务暂时不可用，请稍后核对结果")

    @app.exception_handler(UniqueViolation)
    async def broker_uuid_conflict(request, exc):
        if exc.diag.constraint_name in {"broker_request_domain", "asset_request_domain"}:
            return await http_error(request, HTTPException(409, "原UUID已用于其他账户操作，请查询原回执"))
        return await unexpected(request, exc)

    @app.get("/health/live", tags=["health"])
    async def live():
        return {"status": "alive", "version": __version__, "build": __build__}

    @app.get("/health/ready", tags=["health"])
    async def ready():
        try:
            async with db.connection() as conn:
                await conn.execute("SELECT 1 FROM schema_migrations LIMIT 1")
            return {"status": "ready"}
        except Exception:
            return JSONResponse({"status": "not_ready"}, status_code=503)

    @app.get("/health/container", include_in_schema=False)
    async def container_health():
        from .deployment_watchtower import runtime_ready

        try:
            async with db.connection() as conn:
                healthy = await runtime_ready(conn, version=__version__)
            return JSONResponse(
                {"status": "ready" if healthy else "worker_unavailable"},
                status_code=200 if healthy else 503,
            )
        except Exception:
            return JSONResponse({"status": "not_ready"}, status_code=503)

    @app.get(PREFIX + "/meta", tags=["public"])
    async def meta():
        return {
            "name": "Alcor",
            "version": __version__,
            "build": __build__,
            "environment": settings.environment,
            "configured": bool(settings.database_url),
        }

    @app.get(PREFIX + "/versions", tags=["public"])
    async def versions():
        from .releases import release_records
        return {"version": __version__, "build": __build__, "releases": release_records()}

    async def create_session(conn, user, request_id):
        token = secrets.token_urlsafe(32)
        session = await (
            await conn.execute(
                "INSERT INTO sessions (token_hash,user_id,session_version,expires_at) VALUES (%s,%s,%s,clock_timestamp()+make_interval(hours=>%s)) RETURNING expires_at",
                (digest(token), user["id"], user["session_version"], settings.session_hours),
            )
        ).fetchone()
        await conn.execute(
            "DELETE FROM sessions WHERE user_id=%s AND client_id='new-web' AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=%s AND client_id='new-web' ORDER BY created_at DESC,token_hash LIMIT 20)",
            (user["id"], user["id"]),
        )
        await conn.execute(
            "INSERT INTO audit_events (actor_id,action,request_id) VALUES (%s,'session.created',%s)",
            (user["id"], UUID(request_id)),
        )
        return token, session

    def session_response(response, user, token, session):
        response.set_cookie(
            COOKIE, token, httponly=True, secure=settings.secure_cookie, samesite="strict",
            max_age=settings.session_hours * 3600, path="/",
        )
        return {"user": user, "instance_id": settings.instance_id, "csrf": csrf_token(token), "receipt_scope": digest("receipt-scope:"+digest(token)), **session}

    native_identity = IdentityService(settings,db)
    app.state.native_identity = native_identity
    mount_identity_routes(app,settings,db,native_identity,create_session,session_response,rate_limit)
    mount_legacy_identity(app,settings,db,native_identity,app.state.native_passkeys,app.state.identity_management,rate_limit)
    from .legacy_account_closure import mount_legacy_account_closure
    mount_legacy_account_closure(app,settings,db,rate_limit)
    from .card_preferences_api import mount_card_preferences
    mount_card_preferences(app,settings,db,rate_limit)
    from .card_preference_web import mount_card_preference_web
    mount_card_preference_web(app,db)
    from .card_catalog_api import mount_card_catalog
    mount_card_catalog(app,runtime,db,rate_limit)
    from .card_wallet_api import mount_card_wallet
    mount_card_wallet(app,runtime,db,rate_limit)
    from .card_library_api import mount_card_library
    mount_card_library(app, db)
    from .card_recognition_api import mount_card_recognition
    mount_card_recognition(app, db)
    from .local_host_clipboard_api import mount_local_host_clipboard
    mount_local_host_clipboard(app, db)
    mount_profile_compatibility(app,settings,db,rate_limit)
    mount_personal_profiles(app,settings,db,rate_limit)
    from .resource_api import mount_resources
    mount_resources(app,settings,db,rate_limit)
    mount_native_profile(app,settings,db,rate_limit)
    from .account_devices import mount_account_devices
    mount_account_devices(app, db, rate_limit)
    from .account_signal_api import mount_account_signals
    mount_account_signals(app, settings, db)
    from .operation_history_api import mount_operation_history
    mount_operation_history(app, db)
    from .fire_api import mount_fire_planning
    mount_fire_planning(app, settings, db)
    from .api_documents import mount_api_documents
    mount_api_documents(app, settings, db)
    from .request_observability_api import mount_request_observability
    mount_request_observability(app, settings, db)
    from .activity_api import mount_activity
    mount_activity(app, settings, db)
    from .account_sync_api import mount_account_sync
    mount_account_sync(app, settings, db, rate_limit)
    from .feed_api import mount_feed
    mount_feed(app, db)
    from .celeb_api import mount_celebs
    mount_celebs(app, db)
    from .legacy_feed import mount_legacy_feed
    mount_legacy_feed(app)
    from .public_square_api import mount_public_square
    mount_public_square(app, db)
    from .watchlists_api import mount_watchlists
    mount_watchlists(app, db)
    from .watch_group_icon_api import mount_watch_group_icons
    mount_watch_group_icons(app, settings, db, rate_limit)
    from .broker_accounts import install_broker_accounts
    install_broker_accounts(app)
    from .cash_ledger_api import mount_cash_ledger
    mount_cash_ledger(app, db, rate_limit)
    from .cash_overview_api import mount_cash_overview
    mount_cash_overview(app)
    from .fund_sources_api import mount_fund_sources
    mount_fund_sources(app, rate_limit)
    from .trading_api import mount_trading
    mount_trading(app, db)
    from .price_alert_runtime import from_settings as price_alerts_from_settings
    from .price_alert_api import mount as mount_price_alerts
    app.state.price_alerts = price_alerts_from_settings(db)
    mount_price_alerts(app, app.state.price_alerts)
    from .legacy_notification_api import mount_legacy_notifications
    mount_legacy_notifications(app, settings, app.state.price_alerts)
    from .market_runtime import from_settings as market_from_settings
    from .market_api import mount as mount_market
    app.state.market_authority, _market_transport = market_from_settings(db)
    mount_market(app, app.state.market_authority)
    from .market_history_api import mount_market_history
    mount_market_history(app, app.state.market_authority)
    from .sec_company_api import mount_sec_company_profiles
    mount_sec_company_profiles(app, settings, app.state.market_authority)
    from .sec_financial_api import mount_sec_financial_statements
    mount_sec_financial_statements(app, settings, app.state.market_authority)
    from .earnings_calendar_api import mount_earnings_calendar
    mount_earnings_calendar(app, settings, app.state.market_authority, rate_limit)
    from .dividend_schedule_api import mount_dividend_schedule
    mount_dividend_schedule(app, app.state.market_authority, rate_limit)
    from .market_discovery_api import mount_market_discovery
    mount_market_discovery(app, settings, app.state.market_authority)
    from .legacy_market_reads import mount_legacy_market_reads
    mount_legacy_market_reads(app, settings, app.state.market_authority)
    from .public_market_worker import from_settings as public_market_from_settings
    from .public_market_api import mount_public_market
    public_authority, _public_transport = public_market_from_settings(db)
    mount_public_market(app, db, public_authority)
    from .public_discovery_api import mount_public_discovery
    mount_public_discovery(app, settings, db, quote_authority=public_authority)
    from .public_reference import PublicReference
    from .public_reference_api import mount_public_reference
    from .public_sec_reference import PublicSecAdapter
    from .public_earnings_reference import PublicEarnings
    public_references = PublicReference(db, policy_provider=lambda: settings.public_reference_policies, adapters={
        "company-profile": PublicSecAdapter(db, "company-profile", target_provider=lambda: settings.public_sec_targets),
        "financials": PublicSecAdapter(db, "financials", target_provider=lambda: settings.public_sec_targets),
        "earnings.calendar": PublicEarnings(lambda: settings.public_earnings_targets),
    })
    mount_public_reference(app, db, public_references)
    from .legacy_quote_api import mount_legacy_quote_reads
    mount_legacy_quote_reads(app, settings, app.state.market_authority)
    from .portfolio_overview_api import mount_portfolio_overview
    mount_portfolio_overview(app, db, app.state.market_authority)
    from .portfolio_series_api import mount_portfolio_series
    mount_portfolio_series(app, db, app.state.market_authority)
    from .daily_activity_summary_api import mount_daily_activity_summary
    mount_daily_activity_summary(app, db)
    from .legacy_portfolio_analysis import mount_legacy_portfolio_analysis
    mount_legacy_portfolio_analysis(app, db, app.state.market_authority)
    from .legacy_monthly_kline import mount_legacy_monthly_kline
    mount_legacy_monthly_kline(app, settings, app.state.market_authority)
    from .legacy_history_bars import mount_legacy_history_bars
    mount_legacy_history_bars(app, settings, app.state.market_authority)
    from .legacy_futu_diagnostics import mount_legacy_futu_diagnostics
    mount_legacy_futu_diagnostics(app, settings, app.state.market_authority, _market_transport)
    # Fixed cash collection routes precede the broker account-id route.
    from .legacy_cash_assets import mount_legacy_cash_assets
    mount_legacy_cash_assets(app, rate_limit)
    from .legacy_fund_sources import mount_legacy_fund_sources
    mount_legacy_fund_sources(app, rate_limit)
    from .legacy_broker_read import mount_legacy_broker_reads
    mount_legacy_broker_reads(app)
    from .legacy_cash_read import mount_legacy_cash_reads
    mount_legacy_cash_reads(app)
    from .broker_metadata_api import mount_broker_metadata
    mount_broker_metadata(app, rate_limit)
    from .broker_bindings_api import mount_broker_bindings
    mount_broker_bindings(app, rate_limit)
    from .broker_icons_api import mount_broker_icons
    mount_broker_icons(app, rate_limit)
    from .broker_holding_source_api import mount_broker_holding_source
    mount_broker_holding_source(app, rate_limit)
    from .broker_position_transfer_api import mount_broker_position_transfers
    mount_broker_position_transfers(app, rate_limit)
    from .broker_statements_api import mount_broker_statements
    mount_broker_statements(app, rate_limit)
    from .legacy_broker_statements import mount_legacy_broker_statements
    mount_legacy_broker_statements(app, rate_limit)
    from .legacy_broker_accounts import mount_legacy_broker_accounts
    mount_legacy_broker_accounts(app, rate_limit)
    from .dividend_receipts_api import mount_dividend_receipts
    mount_dividend_receipts(app, db)
    from .dividend_source_worker import from_settings as dividend_sources_from_settings
    from .dividend_source_api import mount_source_chain
    app.state.dividend_sources = dividend_sources_from_settings(db)
    mount_source_chain(app, app.state.dividend_sources)
    from .fee_api import mount_fees, mount_fee_repairs, mount_legacy_fee_repairs, mount_source_attributions
    mount_fees(app,db)
    mount_fee_repairs(app,db)
    mount_legacy_fee_repairs(app,db)
    mount_source_attributions(app,db)
    from .internal_orders_api import mount_internal_orders
    mount_internal_orders(app, db)
    from .record_file_api import mount_record_file_imports
    mount_record_file_imports(app, db)
    from .personal_data_transfer_api import mount_personal_data_transfer
    mount_personal_data_transfer(app,db)
    from .simple_ledger_api import mount_simple_ledger
    mount_simple_ledger(app,db)
    from .agent_runtime_api import mount_agent_runtime
    mount_agent_runtime(app,db)
    from .system_operations_api import mount_system_operations
    mount_system_operations(app,db)
    from .portfolio_records_api import mount_portfolio_records
    mount_portfolio_records(app, db)
    from .legacy_portfolio import mount_legacy_portfolio
    mount_legacy_portfolio(app, settings, db)
    from .legacy_record_writes import mount_legacy_record_writes
    mount_legacy_record_writes(app, settings, db)
    from .legacy_watchlists import mount_legacy_watchlists
    mount_legacy_watchlists(app, settings, db, rate_limit)

    from .fx_api import mount_rates
    app.state.reference_rates = mount_rates(app, settings, db)
    from .reference_receipts import mount_reference_receipts
    mount_reference_receipts(app, db)
    from .market_calendar_api import mount_calendar
    mount_calendar(app, db, settings)

    @app.get(PREFIX + "/auth/registration", response_model=RegistrationOut, tags=["public"])
    async def registration():
        async with db.connection() as conn:
            status = await registration_status(conn)
            return {**status, "requires_setup_token": bool(status["first_user"] and settings.environment == "production")}

    @app.post(PREFIX + "/session/register", response_model=SessionOut, status_code=201, tags=["session"])
    async def register(data: RegisterInput, request: Request, response: Response):
        trusted_origin(request)
        address = request.client.host if request.client else "unknown"
        user, token, session = await register_account(
            db, rate_limit, address, data.username, data.password, request.state.request_id, create_session,
            setup_token=data.setup_token.get_secret_value() if data.setup_token else None
        )
        return session_response(response, user, token, session)

    @app.post(PREFIX + "/session/login", response_model=SessionOut | FactorChallengeOut, tags=["session"])
    async def login(data: LoginInput, request: Request, response: Response):
        trusted_origin(request)
        address = request.client.host if request.client else "unknown"
        # Do not trust a caller-controlled X-Forwarded-For header for the authentication budget.
        ip_ok = await rate_limit(db, digest("ip:" + address), 50)
        user_ok = await rate_limit(db, digest("login:" + data.login.strip().lower()), 12)
        if not ip_ok or not user_ok:
            raise HTTPException(429, "尝试次数过多，请稍后再试")
        async with db.connection() as conn:
            rows = await (
                await conn.execute(
                    "SELECT * FROM users WHERE lower(username)=lower(%s) OR (email<>'' AND lower(email)=lower(%s)) LIMIT 2",
                    (data.login.strip(), data.login.strip()),
                )
            ).fetchall()
        row = rows[0] if len(rows) == 1 else None
        valid = await asyncio.to_thread(
            verify_password, data.password, row["password_hash"] if row else DUMMY_HASH
        )
        if not row or not valid or not row["active"]:
            raise HTTPException(401, "账号或密码不正确")
        async with db.connection() as conn, conn.transaction():
            # Recheck after the slow password calculation; password/role/active changes cannot resurrect a session.
            current = await (
                await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (row["id"],))
            ).fetchone()
            if (
                not current
                or not current["active"]
                or current["password_hash"] != row["password_hash"]
                or current["session_version"] != row["session_version"]
            ):
                raise HTTPException(401, "账号状态已变化，请重新登录")
            factor_challenge = await native_identity.challenge_password(conn,current,response)
            if factor_challenge:
                return factor_challenge
            token, session = await create_session(conn, current, request.state.request_id)
        return session_response(response, current, token, session)

    @app.get(PREFIX + "/session", response_model=SessionOut, tags=["session"])
    async def session(who: Member):
        return {
            "user": who.__dict__,
            "instance_id": settings.instance_id,
            "csrf": who.csrf,
            "receipt_scope": digest("receipt-scope:"+who.token_hash),
            "expires_at": who.expires_at,
        }

    @app.post(PREFIX + "/session/logout", status_code=204, tags=["session"])
    async def logout(response: Response, who: Member):
        async with db.connection() as conn, conn.transaction():
            from .broker_accounts import serialize_brokers
            from .broker_position_transfers import purge_broker_position_transfer_previews
            from .fund_sources import purge_fund_source_previews
            await serialize_brokers(conn, who.id)
            await purge_broker_position_transfer_previews(conn, who.id)
            await purge_fund_source_previews(conn, who.id)
            await conn.execute(
                "DELETE FROM sessions WHERE token_hash=%s AND user_id=%s", (who.token_hash, who.id)
            )
            await conn.execute(
                "INSERT INTO audit_events (actor_id,action) VALUES (%s,'session.revoked')", (who.id,)
            )
        response.delete_cookie(
            COOKIE, path="/", secure=settings.secure_cookie, httponly=True, samesite="strict"
        )

    @app.get(PREFIX + "/profile", response_model=ProfileOut, tags=["profile"])
    async def own_profile(who: Member):
        async with db.connection() as conn:
            return await profiles.read_profile(conn, who.id)

    @app.patch(PREFIX + "/profile", response_model=ProfileOut, tags=["profile"])
    async def save_profile(data: ProfileInput, request: Request, who: Member):
        await profile_limits(request, db, who, rate_limit)
        avatar = await asyncio.to_thread(profiles.normalize_avatar, data.avatar_data) if data.avatar_data is not None else None
        return await profiles.update_profile(db, who, data, avatar, UUID(request.state.request_id))

    @app.get(PREFIX + "/profile/avatar", tags=["profile"], responses={200: {"content": {"image/jpeg": {}}}})
    async def own_avatar(request: Request, who: Member, revision: UUID):
        return await app.state.read_profile_avatar(request, revision)

    @app.get(PREFIX + "/profile/activity", response_model=ActivityOut, tags=["profile"])
    async def own_activity(who: Member):
        return await profiles.activity(db, who.id)

    @app.get(PREFIX + "/system/overview", response_model=OverviewOut, tags=["administration"])
    async def overview(who: Admin):
        from .system_overview import read_overview
        return await read_overview(app, who)

    @app.get(PREFIX + "/connections/{kind}", response_model=ConnectionSettingsOut, tags=["administration"])
    async def connection_settings(kind: Kind, who: Admin):
        return await connections.read(kind)

    @app.post(PREFIX + "/connections/{kind}/test", response_model=ConnectionReceiptOut, tags=["administration"])
    async def test_connection(kind: Kind, data: ConnectionInput, who: Admin):
        if data.config.kind != kind:
            raise HTTPException(422, "连接类型不匹配")
        return await connections.operate(who, data, 'test')

    @app.put(PREFIX + "/connections/{kind}", response_model=ConnectionReceiptOut, tags=["administration"])
    async def save_connection(kind: Kind, data: ConnectionInput, who: Admin):
        if data.config.kind != kind:
            raise HTTPException(422, "连接类型不匹配")
        return await connections.operate(who, data, 'save')

    @app.get(PREFIX + "/connections/{kind}/receipts/{request_id}", response_model=ConnectionReceiptOut, tags=["administration"])
    async def connection_receipt(kind: Kind, request_id: UUID, who: Admin):
        async with db.connection() as conn:
            row = await (await conn.execute('SELECT result FROM connection_receipts WHERE owner_id=%s AND kind=%s AND request_id=%s', (who.id, kind, request_id))).fetchone()
        if not row:
            raise HTTPException(404, '未查到此请求的回执')
        result = row['result']
        if result['status'] == 'pending' and connections.applied.get(kind) == UUID(result['revision']):
            result |= {'status': 'saved', 'message': '已保存并应用'}
        return result

    @app.get(PREFIX + "/system/migration/work-status", tags=["administration"])
    async def migration_work_status(who: Admin):
        return JSONResponse(read_work_status(settings.inventory_file), headers={"Cache-Control":"no-store, private"})

    @app.get(PREFIX + "/system/migration", tags=["administration"])
    async def migration_register(who: Admin, summary: bool = False):
        if not settings.inventory_file.is_file():
            raise HTTPException(503, "迁移清单尚未生成")
        try:
            register = json.loads(settings.inventory_file.read_text())
            rules = json.loads(settings.capability_file.read_text())
            plan = build_capability_plan(register, rules)
            if summary:
                return {"summary": register["summary"], "capability_plan": {"summary": plan["summary"]}}
            return {**register, "capability_plan": plan}
        except (OSError, ValueError, KeyError, TypeError):
            raise HTTPException(503, "迁移能力清单不可用，请核对清单配置") from None

    @app.post(PREFIX + "/tasks", response_model=TaskOut, status_code=202, tags=["tasks"])
    async def create_task(data: TaskInput, who: Admin):
        return await tasks.submit(db, who, data)

    @app.get(PREFIX + "/tasks", response_model=TaskList, tags=["tasks"])
    async def task_list(
        who: Admin,
        limit: int = Query(25, ge=1, le=100),
        cursor: str | None = Query(None, max_length=256),
        status: TaskStatus | None = None,
    ):
        return await tasks.list_tasks(db, who, limit, cursor, status)

    @app.get(PREFIX + "/tasks/receipts/{request_id}", response_model=TaskOut, tags=["tasks"])
    async def receipt(request_id: UUID, who: Admin):
        async with db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s", (who.id, request_id)
                )
            ).fetchone()
        if not row:
            raise HTTPException(404, "未查到此请求的受理回执")
        return row

    @app.get(PREFIX + "/tasks/{task_id}", response_model=TaskDetail, tags=["tasks"])
    async def task_detail(task_id: UUID, who: Admin):
        return await tasks.detail(db, who, task_id)

    @app.post(PREFIX + "/tasks/{task_id}/cancel", response_model=TaskOut, tags=["tasks"])
    async def cancel_task(task_id: UUID, who: Admin):
        return await tasks.cancel(db, who, task_id)

    from .client_auth import router as client_router
    from .operational_request_import import router as operational_request_router
    from .operational_document_import import router as operational_document_router
    app.include_router(operational_request_router)
    app.include_router(operational_document_router)
    app.include_router(account_preferences_router)
    app.include_router(client_router)
    from .connection_access import router as connection_access_router
    app.include_router(connection_access_router)
    from .backups import router as backup_router
    app.include_router(backup_router)
    from .backup_schedule_api import mount_backup_schedule
    mount_backup_schedule(app,db)
    from .account_admin import router as account_router
    app.include_router(account_router)

    from .deployments import router as deployment_router
    app.include_router(deployment_router)
    from .deployment_observations import router as deployment_observations_router
    app.include_router(deployment_observations_router)
    from .deployment_config import router as deployment_config_router
    app.include_router(deployment_config_router)

    from .media_storage import router as media_router
    app.include_router(media_router)

    from .source_registry import load_registry
    from .source_api import mount_source_authority
    mount_source_authority(app, runtime, load_registry(runtime))
    from .mapping_api import mount_financial_mappings
    mount_financial_mappings(app)
    from .estimate_api import mount_fee_estimates
    mount_fee_estimates(app)
    from .actual_fee_api import mount_actual_fee_confirmations
    mount_actual_fee_confirmations(app)
    from .native_actual_fee_api import mount_native_actual_fees
    mount_native_actual_fees(app)
    from .financing_api import mount_financing
    mount_financing(app)
    from .legacy_financing import mount_legacy_financing
    mount_legacy_financing(app)
    from .trade_amendment_api import mount_trade_amendments
    mount_trade_amendments(app)
    from .legacy_trade_api import mount_legacy_trade_commands
    mount_legacy_trade_commands(app)
    from .legacy_native_orders import mount_legacy_native_orders
    mount_legacy_native_orders(app)
    from .legacy_flat_orders import mount_legacy_flat_orders
    mount_legacy_flat_orders(app)
    from .internal_order_observations import mount_internal_order_observations
    mount_internal_order_observations(app, db, app.state.market_authority)
    from .registered_baseline_api import mount_registered_baselines
    mount_registered_baselines(app)
    from .fee_estimate_head import mount_fee_estimate_head
    mount_fee_estimate_head(app)

    from .resource_import_api import mount_resource_import
    mount_resource_import(app, runtime)
    from .watch_group_import_api import mount_watch_group_import
    mount_watch_group_import(app, runtime)
    from .watch_group_source_icon_api import mount_watch_group_source_icons
    mount_watch_group_source_icons(app, runtime)

    from .source_history import mount_source_history
    mount_source_history(app)

    from .resource_import_history import mount_resource_import_history
    mount_resource_import_history(app)

    from .admin_attachment_api import mount_admin_attachments
    mount_admin_attachments(app, runtime)
    from .attachment_source_api import mount_attachment_source_import
    mount_attachment_source_import(app, db)

    from .mail_template_api import mount_mail_templates
    mount_mail_templates(app, db)
    from .site_settings_api import mount_site_settings
    mount_site_settings(app,settings,db)
    from .private_runtime_settings_api import mount_private_runtime_settings
    mount_private_runtime_settings(app, db)
    from .provider_setting_operations_api import mount_provider_setting_operations
    mount_provider_setting_operations(app, db)
    from .legacy_mail_preview import mount_legacy_mail_preview, mount_mail_preview
    mount_legacy_mail_preview(app, db)
    mount_mail_preview(app, db)
    from .legacy_mail_template_settings import mount_legacy_mail_template_settings
    mount_legacy_mail_template_settings(app, db)
    from .country_catalog_api import mount_country_catalog
    mount_country_catalog(app)
    from .asset_lookup_api import mount_asset_catalog
    mount_asset_catalog(app, settings, db)
    from .asset_sources_api import mount_asset_sources
    mount_asset_sources(app, db)
    from .legacy_broker_directory import mount_legacy_broker_directory
    mount_legacy_broker_directory(app)
    from .financial_report_api import mount_financial_reports
    mount_financial_reports(app, settings, db)
    from .legacy_deployment import mount_legacy_deployment
    mount_legacy_deployment(app, settings, db)

    from .personal_font_api import mount_personal_fonts
    mount_personal_fonts(app, runtime, db, rate_limit)
    from .font_source_api import mount_font_source_import
    mount_font_source_import(app, runtime, db, rate_limit)
    from .font_source_catalog_api import mount_font_source_catalog
    mount_font_source_catalog(app, runtime, db, rate_limit)

    from .system_asset_api import mount_system_assets
    mount_system_assets(app, runtime, db, rate_limit)
    from .media_compat_api import mount_media_compat
    mount_media_compat(app, db)
    from .public_site_api import mount_public_site
    mount_public_site(app, db)

    from .fire_web import router as fire_web_router
    app.include_router(fire_web_router)
    from .fire_app_packages import router as fire_packages_router
    app.include_router(fire_packages_router)
    from .fire_current_web import router as fire_current_web_router
    app.include_router(fire_current_web_router)

    # Unknown legacy APIs remain unavailable. SPA fallback must never turn an API 404 into HTML/200.
    @app.api_route(
        "/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False
    )
    async def unknown_api(path: str):
        raise HTTPException(404, "接口尚未提供")

    if (settings.web_dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=settings.web_dist / "assets"), name="assets")

    @app.get("/service-worker.js", include_in_schema=False)
    async def service_worker():
        path = settings.web_dist / "service-worker.js"
        if not path.is_file():
            raise HTTPException(503, "离线组件尚未构建")
        return FileResponse(path, media_type="application/javascript", headers={
            "Cache-Control": "no-cache", "Service-Worker-Allowed": "/"
        })

    @app.get("/{path:path}", include_in_schema=False)
    async def web(path: str):
        if path.startswith(("api", "health", "assets")) or "." in path:
            raise HTTPException(404, "资源不存在")
        index = settings.web_dist / "index.html"
        if not index.is_file():
            raise HTTPException(503, "前端尚未构建")
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    app.add_middleware(ObserveRequests, observations=observations, routes=app.routes)
    app.add_middleware(CountAccountRequests, activity=request_activity)
    if settings.trusted_proxy_ips:
        from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=settings.trusted_proxy_ips)
    return app
