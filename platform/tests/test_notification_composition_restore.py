"""Actual composed API/source/delivery/receipt/restore, using only loopback providers and private PG."""

import json
import re
import threading
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import psycopg
import pytest
import pytest_asyncio
import test_backups as backups
from alcor_api.business_notification_worker import dispatch_one
from alcor_api.business_notifications import bridge_dividends
from alcor_api.cli import create_user
from alcor_api.db import Database
from alcor_api.dividend_receipts import DividendReceipts
from alcor_api.dividend_source_worker import cycle as source_cycle
from alcor_api.main import create_app
from alcor_api.market_alert_reader import SharedQuotes, project_alert_demands
from alcor_api.market_authority import Policy
from alcor_api.market_calendar import Calendars
from alcor_api.market_contract import Query
from alcor_api.market_transport import Transport
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.notification_provider_wire import Origin
from alcor_api.notification_providers import ProviderTarget
from alcor_api.notification_sender import Sender
from alcor_api.price_alert_runtime import from_settings as alerts_from_settings
from alcor_api.price_alert_worker import claim as claim_alert
from alcor_api.price_alert_worker import execute as execute_alert
from alcor_api.security import Identity, digest
from price_alerts_candidate.test_notification_bindings import binding_mutation, configure
from price_alerts_candidate.test_price_alerts import upsert
from psycopg.rows import dict_row
from test_notification_composition import statement
from test_trading import setup


@pytest.fixture
def controlled_provider():
    state = {"requests": [], "messages": []}
    announcement = {
        "success": True,
        "result": {
            "pages": 1,
            "count": 1,
            "data": [
                {
                    "SECURITY_CODE": "600000",
                    "PRETAX_BONUS_RMB": "2.5",
                    "ASSIGN_PROGRESS": "实施分配",
                    "REPORT_DATE": "2025-12-31",
                    "EX_DIVIDEND_DATE": "2026-01-02 00:00:00",
                    "PLAN_NOTICE_DATE": "2025-12-25 00:00:00",
                    "EQUITY_RECORD_DATE": "2026-01-01 00:00:00",
                    "BONUS_RATIO": 0,
                    "IT_RATIO": 0,
                    "IMPL_PLAN_PROFILE": "每10股派息2.5元",
                }
            ],
        },
    }
    market = {
        "query": asdict(Query("latest", "US", "AAPL")),
        "licenseRevision": "controlled-license",
        "facts": [
            {
                "at": "2026-10-20T14:00:00+00:00",
                "price": "340.000001",
                "currency": "USD",
                "session": "REGULAR",
                "cached": False,
                "name": "Fixture",
            }
        ],
        "nextCursor": None,
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            state["requests"].append(("GET", path))
            body = (
                announcement
                if path == "/securities/api/data/v1/get"
                else market
                if path == "/market"
                else {"errcode": 0, "access_token": "controlled-access", "expires_in": 7200}
            )
            self.reply(json.dumps(body, ensure_ascii=False).encode())

        def do_POST(self):
            path = urlsplit(self.path).path
            state["requests"].append(("POST", path))
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["messages"].append(body["text"]["content"])
            self.reply(b'{"errcode":0,"msgid":"controlled-accepted"}')

        def reply(self, body):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_port, state
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


@pytest_asyncio.fixture
async def configured(settings, pg, tmp_path, controlled_provider):
    async for value in backups.configured.__wrapped__(settings, pg, tmp_path):
        owner = await create_user(value, "ComposedBackup", "Synthetic9Pass")
        port, _ = controlled_provider
        value.dividend_source_targets = [
            {
                "id": "controlled-announcements",
                "source": "eastmoney",
                "host": "127.0.0.1",
                "port": port,
                "addresses": ["127.0.0.1"],
                "approved_access": True,
                "fixture": True,
                "scheme": "http",
                "allow_plaintext": True,
            }
        ]
        policy = Policy(
            "controlled-market",
            "controlled_market",
            "fixture-v1",
            "loopback",
            "controlled-target",
            owner,
            "controlled-license",
            ("latest",),
            ("US",),
            True,
        )
        value.market_data_policies = [asdict(policy)]
        target = ProviderTarget(
            "fixture-wechat",
            "wechat",
            {"api": Origin("http", "127.0.0.1", port, ("127.0.0.1",), ("/cgi-bin",), True)},
            True,
            True,
        )
        value.business_notification_targets = [asdict(target)]
        yield value


@pytest_asyncio.fixture
async def backup_app(configured):
    app = create_app(configured)
    async with app.router.lifespan_context(app):
        yield app


@pytest_asyncio.fixture
async def bc(backup_app):
    import httpx

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=backup_app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        login = await client.post(
            "/api/session/login", json={"login": "ComposedBackup", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        client.headers["x-csrf-token"] = login.json()["csrf"]
        yield client


async def test_source_shared_notices_controlled_delivery_actual_income_and_restore_keep_one_authority(
    bc, backup_app, configured, controlled_provider
):
    app = backup_app
    port, state = controlled_provider
    configured_source = await bc.post(
        "/api/dividends/sources",
        json={
            "requestId": str(uuid4()),
            "targetId": "controlled-announcements",
            "market": "CN",
            "code": "600000",
            "periodFrom": None,
            "periodThrough": None,
        },
    )
    assert configured_source.status_code == 201, configured_source.text
    source_revision = configured_source.json()["revision"]
    queued = await bc.post(
        "/api/dividends/sources/tasks",
        json={"request_id": str(uuid4()), "data": {"configRevision": source_revision}},
    )
    assert queued.status_code == 202, queued.text
    source_result = await source_cycle(app.state.dividend_sources, uuid4())
    assert source_result["state"] == "succeeded"
    source = (await bc.get("/api/dividends/sources/" + source_revision)).json()
    assert source["items"][0]["announcement"]["amount"] == "0.25" and not source["completeHistory"]
    async with app.state.db.connection() as conn, conn.transaction():
        assert await bridge_dividends(conn) == 1 and await bridge_dividends(conn) == 0
        assert (await (await conn.execute("SELECT count(*) AS n FROM cash_ledger_entries")).fetchone())[
            "n"
        ] == 0
    ma = app.state.market_authority
    now = datetime(2026, 10, 20, 14, 0, 0, tzinfo=UTC)
    ma.clock = lambda: now
    app.state.price_alerts.reader = SharedQuotes(ma)
    app.state.price_alerts.now = lambda: now
    market_source = await bc.post(
        "/api/market/sources", json={"request_id": str(uuid4()), "policy_id": "controlled-market"}
    )
    assert market_source.status_code == 200, market_source.text
    await Calendars(app.state.db).ensure_builtin()
    await upsert(bc)
    now += timedelta(seconds=1)
    await project_alert_demands(ma)
    await schedule(ma)
    target = f"http://127.0.0.1:{port}/market"
    approval = {
        "target": ["http", "127.0.0.1", port, "/market"],
        "addresses": ["127.0.0.1"],
        "allow_plaintext": True,
    }
    transport = Transport(app.state.db, controlled_http={"controlled-market": (target, approval)})
    task = await claim(app.state.db, uuid4())
    assert await execute(ma, task, transport) == "observed"
    alert = await claim_alert(app.state.db, uuid4())
    assert await execute_alert(app.state.price_alerts, alert) == "triggered"
    await configure(bc, "wechat")
    started, _ = await binding_mutation(
        bc, {"action": "wechat_start", "recipient": "SyntheticMember", "revision": 0}
    )
    assert started.status_code == 200, started.text
    channel = next(row for row in started.json()["snapshot"]["channels"] if row["channel"] == "wechat")
    assert await dispatch_one(app.state.db, uuid4(), Sender(app.state.price_alerts.bindings)) == "accepted"
    code = re.search(r"验证码：(\d{6})", state["messages"][-1])[1]
    confirmed, _ = await binding_mutation(
        bc,
        {
            "action": "wechat_confirm",
            "challengeId": channel["challengeId"],
            "verificationCode": code,
            "revision": 1,
            "enabled": True,
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    pending, _ = await binding_mutation(bc, {"action": "test", "channel": "wechat"})
    assert pending.status_code == 200, pending.text
    _, record = await setup(bc)
    data = statement(record)
    preview = await bc.post("/api/dividends/receipts/preview", json=data)
    assert preview.status_code == 200, preview.text
    receipt = await bc.post(
        "/api/dividends/receipts/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert receipt.status_code == 200, receipt.text
    assert receipt.json()["cashDelta"] == "8.0" and receipt.json()["ownerCashAfter"] is None
    tables = (
        "dividend_announcement_revisions",
        "dividend_source_configs",
        "dividend_source_pages",
        "dividend_review_notices",
        "dividend_receipts",
        "business_notification_events",
        "business_notification_deliveries",
        "business_notification_sources",
        "business_notification_provider_revisions",
        "business_notification_bindings",
        "market_source_configs",
        "market_source_pages",
        "market_facts",
        "market_data_operations",
        "market_cache_generations",
    )
    async with app.state.db.connection() as conn:
        original = {
            table: await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
            for table in tables
        }
        owner = original["market_source_configs"][0]["owner_id"]
    backup_id, _ = await backups.create_capsule(bc, app, configured)
    restore_preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert restore_preview.status_code == 200, restore_preview.text
    restore, _ = await backups.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=restore_preview.json()["restore_ticket"],
    )
    restored = await backups.execute(app, configured, UUID(restore["id"]))
    assert restored["sessions_revoked"]
    destination = configured.restore_targets[0]
    token = "controlled-recovery-" + uuid4().hex
    async with await psycopg.AsyncConnection.connect(
        destination.database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        for table in tables:
            assert (
                await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
                == original[table]
            ), table
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        await conn.execute(
            "INSERT INTO sessions(token_hash,user_id,session_version,client_id,expires_at) VALUES(%s,%s,%s,'new-web',clock_timestamp()+interval '1 day')",
            (digest(token), owner, user["session_version"]),
        )
    recovery = configured.model_copy(
        update={
            "database_url": destination.database_url,
            "instance_id": destination.instance_id,
            "environment": "test",
        }
    )
    db = Database(recovery)
    await db.open()
    try:
        before = len(state["requests"])
        recovered_alerts = alerts_from_settings(db)
        assert await dispatch_one(db, uuid4(), Sender(recovered_alerts.bindings)) == "restore_quarantined"
        who = Identity(
            id=owner,
            username=user["username"],
            role=user["role"],
            token_hash=digest(token),
            csrf="",
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        assert await DividendReceipts(db).receipt(who, UUID(data["requestId"])) == receipt.json()
        assert len(state["requests"]) == before and len(state["messages"]) == 1
    finally:
        await db.close()
