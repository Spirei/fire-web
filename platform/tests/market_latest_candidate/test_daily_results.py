from dataclasses import asdict
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import httpx

from alcor_api.cli import create_user
from alcor_api.fx_reference import persist as store_fx
from alcor_api.market_calendar import Calendars
from alcor_api.market_contract import Query, canonical
from alcor_api.market_history_reads import LicensedHistory
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.personal_data_transfer import digest
from alcor_api.portfolio_daily import capture_day, capture_due
from alcor_api.portfolio_daily_history import prepare_due
from test_cash_ledger import command, submit
from test_legacy_trade_corrections import native_headers
from test_trading import setup

from .test_market_authority import demand, market, market_settings  # noqa: F401


class DailySource:
    fixture = True

    async def read(self, policy, query, cursor):
        facts = [{"at": at, "o": "99", "h": "110", "l": "90", "c": price, "currency": "USD"}
                 for at, price in [("2026-10-19T04:00:00+00:00", "100"), ("2026-10-20T04:00:00+00:00", "103")]]
        return canonical({"query": asdict(query), "licenseRevision": policy.license_revision,
                          "facts": facts, "nextCursor": None}).encode(), "controlled_source_body"


async def test_worker_prepares_held_security_without_a_client_history_request(market):  # noqa: F811
    client, _, authority, _, source_revision = market
    account, _ = await setup(client, qty="2", cost="95")
    await Calendars(authority.db).ensure_builtin()
    await prepare_due(authority, date(2026, 10, 20))
    await prepare_due(authority, date(2026, 10, 20))
    assert await schedule(authority) == 1
    task = await claim(authority.db, uuid4(), kind="market.history")
    assert task and await execute(authority, task, DailySource()) == "complete"
    async with authority.db.connection() as conn:
        rows = await (await conn.execute("""
            SELECT s.source_revision,s.query,d.origin FROM market_streams s
            JOIN market_demands d ON d.owner_id=s.owner_id AND d.stream_id=s.id
            JOIN broker_accounts b ON b.owner_id=s.owner_id AND b.id=%s
            WHERE d.origin='portfolio.daily'
        """, (account,))).fetchall()
    assert len(rows) == 1 and str(rows[0]["source_revision"]) == source_revision
    assert rows[0]["query"]["through"] == "2026-10-20"


async def test_daily_results_retain_exact_inputs_keep_versions_and_explain_a_gap(market, tmp_path):  # noqa: F811
    client, app, authority, _, source_revision = market
    # This isolated test supplies the same source authorization for the records API.
    app.state.market_authority.policies = authority.policies
    app.state.market_authority.policy_provider = None
    db = authority.db
    account, record = await setup(client, qty="2", cost="95")
    await Calendars(db).ensure_builtin()
    funding = datetime(2026, 10, 18, tzinfo=UTC)
    now = datetime(2026, 10, 21, 1, tzinfo=UTC)
    async with db.connection() as conn:
        owner = (await (await conn.execute("SELECT owner_id FROM broker_accounts WHERE id=%s", (account,))).fetchone())["owner_id"]
        await conn.execute("UPDATE broker_accounts SET created_at=%s WHERE id=%s", (funding, account))
        await conn.execute("UPDATE portfolio_records SET created_at=%s,updated_at=%s WHERE owner_id=%s AND id=%s",
                           (funding, funding, owner, record["id"]))
    history = LicensedHistory(authority, automatic=True)
    yesterday, today = date(2026, 10, 19), date(2026, 10, 20)
    gap = await capture_day(db, history, owner, "real", yesterday, now=now)
    assert gap["revision"] == 1 and gap["pnl"] is None and gap["equity"] is None
    assert {item["reason"] for item in gap["missing"]} == {"missing_close", "missing_prior_equity"}
    assert await capture_day(db, history, owner, "real", yesterday, now=now) is None

    query = Query("bars", "US", "AAPL", "day", "none", start="2026-10-19", through="2026-10-20")
    await demand(client, source_revision, query)
    assert await schedule(authority) == 1
    task = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, task, DailySource()) == "complete"
    opening = await capture_day(db, history, owner, "real", yesterday, now=now)
    assert opening["revision"] == 2 and Decimal(opening["equity"]) == Decimal(1200)
    assert opening["pnl"] is None and opening["missing"] == [{"reason": "missing_prior_equity"}]
    await submit(client, command(account, action="external_deposit", amount="12.25", occurredAt="2026-10-20T13:00:00Z"))
    result = await capture_day(db, history, owner, "real", today, now=now)
    assert result["state"] == "complete" and Decimal(result["pnl"]) == Decimal(6)
    assert Decimal(result["equity"]) == Decimal("1218.25") and Decimal(result["externalFlow"]) == Decimal("12.25")
    assert result["priorRevision"] == 2 and result["positions"][0]["recordId"] == record["id"]
    close = result["positions"][0]["close"]
    assert close["sourceRevision"] == source_revision and close["sourceTime"].startswith("2026-10-20")
    assert close["factId"] and close["originalPageId"] and len(close["originalSha256"]) == 64
    assert result["cashPostings"][0]["kind"] == "external_deposit" and result["cashPostings"][0]["id"]

    route = "/api/personal-data-transfer/daily-results"
    response = await client.get(route, params={"day": today.isoformat(), "revision": result["revision"]})
    assert response.status_code == 200, response.text
    evidence = response.json()
    assert evidence["inputSha256"] == digest({key: value for key, value in result.items() if key != "revision"})
    assert (await client.get(route, params={"day": yesterday.isoformat(), "revision": 1})).json()["pnl"] is None
    revised = (await client.get(route, params={"day": yesterday.isoformat(), "revision": 2})).json()
    assert revised["revisions"] == [2, 1] and "original" not in revised
    assert revised["positions"][0]["close"]["value"] == "100"
    assert await capture_day(db, history, owner, "real", today, now=now) is None
    assert (await client.get(route, params={"kind": "simulated"})).json() == {"items": [], "next": None}
    assert (await client.get(route, headers={"X-Alcor-Expected-Account": "another-user"})).status_code == 403
    listing = (await client.get(route)).json()["items"]
    assert [(row["day"], row["revision"]) for row in listing] == [("2026-10-20", 1), ("2026-10-19", 2)]
    assert (await client.get(route, params={"folders": True})).json() == {"items": [{"year": 2026, "count": 2}], "next": None}
    assert (await client.get(route, params={"folders": True, "year": 2026})).json() == {
        "items": [{"year": 2026, "month": 10, "count": 2}], "next": None}
    assert (await client.get(route, params={"year": 2026, "month": 10})).json() == {"items": listing, "next": None}
    assert (await client.get(route, params={"year": 2026, "month": 11})).json() == {"items": [], "next": None}
    assert (await client.get(route, params={"month": 10})).status_code == 400
    await capture_due(db, history, now=now)
    caught_up = (await client.get(route, params={"day": "2026-10-18"})).json()
    assert caught_up["day"] == "2026-10-18" and caught_up["revision"] == 1

    contract = (await client.get("/api/v2/auth/config")).json()["data"]["portfolio_analysis_days"]
    path = contract["path"]
    assert contract == {"version": 1, "path": "/api/v2/account-assets/analysis-days", "read_scope": "portfolio.read"}
    assert (await client.get(path)).status_code == 401
    headers = await native_headers(db, owner)
    prepared = await client.get(path, headers=headers)
    assert prepared.status_code == 200, prepared.text
    assert "no-store" in prepared.headers["cache-control"]
    data = prepared.json()["data"]
    assert data["accountId"] == owner and data["basis"] == "settled_real_ledger_v1"
    days = {row["day"]: row for row in data["items"]}
    latest = days["2026-10-20"]
    assert Decimal(latest["pnl"]) == 6 and Decimal(latest["equity"]) == Decimal("1218.25")
    assert Decimal(latest["calendar"]["profit"]["USD"]) == 6 and "rows" not in latest["calendar"]
    web_path = "/api/fire/asset-analysis/trend"
    web = await client.get(web_path)
    assert web.status_code == 200, web.text
    assert "no-store" in web.headers["cache-control"]
    web_data = web.json()
    assert web_data["accountId"] == owner
    web_days = {row["day"]: row for row in web_data["items"]}
    assert web_days["2026-10-20"] == {**latest, "calendar": None}
    proxied = "https://testserver" + web_path
    assert (await client.get(proxied, headers={"x-csrf-token": ""})).status_code == 403
    proxy_read = await client.get(proxied)
    assert proxy_read.status_code == 200 and proxy_read.json() == web_data
    assert (await client.get(proxied, headers={"sec-fetch-site": "cross-site"})).status_code == 403
    assert (await client.get(web_path, headers={"X-Alcor-Expected-Account": "another-user"})).status_code == 403
    assert (await client.get(web_path, params={"ownerId": "another-user"})).status_code == 400
    detail = await client.get(path, headers=headers, params={"day": "2026-10-20"})
    assert detail.status_code == 200, detail.text
    assert len(detail.json()["data"]["items"]) == 1
    [gain] = detail.json()["data"]["items"][0]["calendar"]["rows"]
    assert gain["recordId"] == record["id"] and Decimal(gain["profit"]) == 6
    (tmp_path / "native-prepared-analysis.json").write_bytes(prepared.content)
    assert (await client.get(path, headers=headers, params={"day": "2026-10-20", "before": "2026-10-21"})).status_code == 400
    other = await create_user(db.settings, "OtherDaily", "Synthetic9Pass", email="other-daily@example.invalid")
    other_headers = await native_headers(db, other)
    assert (await client.get(path, headers=other_headers)).json()["data"]["items"] == []
    assert (await client.get(path, headers={**other_headers, "x-alcor-expected-account": owner})).status_code == 403
    await submit(client, command(account, action="external_deposit", amount="1", occurredAt="2026-10-20T14:00:00Z"))
    stale = (await client.get(path, headers=headers, params={"day": "2026-10-20"})).json()["data"]["items"][0]
    assert stale["retired"] and stale["equity"] is None and stale["calendar"] is None
    web_stale = (await client.get(web_path)).json()["items"][0]
    assert web_stale["retired"] and web_stale["equity"] is None


async def test_web_trend_accepts_the_displayed_browser_session_through_proxy(app, admin):
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver",
                                 headers={"origin": "http://testserver"}) as browser:
        login = await browser.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
        assert login.status_code == 200, login.text
        profile = await browser.get("/api/fire/session")
        assert profile.status_code == 200, profile.text
        headers = {"X-CSRF-Token": profile.json()["csrf"], "X-Alcor-Expected-Account": admin}
        target = "https://testserver/api/fire/asset-analysis/trend"
        assert (await browser.get(target)).status_code == 403
        result = await browser.get(target, headers=headers)
        assert result.status_code == 200 and result.json()["accountId"] == admin
        assert (await browser.get(target, headers={**headers, "X-Alcor-Expected-Account": "another-user"})).status_code == 403
        assert (await browser.get(target, headers={**headers, "Sec-Fetch-Site": "cross-site"})).status_code == 403
        native = await browser.get("https://testserver/api/v2/account-assets/analysis-days", headers=headers)
        assert native.status_code == 403


async def test_same_day_fx_stays_frozen_when_cash_is_revised(market):  # noqa: F811
    client, _, authority, _, _ = market
    db = authority.db
    account, record = await setup(client, currency="HKD", market="HK", code="00700", amount="780")
    funding = datetime(2026, 11, 16, tzinfo=UTC)
    now = datetime(2026, 11, 20, 2, tzinfo=UTC)
    async with db.connection() as conn:
        owner = (await (await conn.execute("SELECT owner_id FROM broker_accounts WHERE id=%s", (account,))).fetchone())["owner_id"]
        await conn.execute("UPDATE broker_accounts SET created_at=%s WHERE id=%s", (funding, account))
        await conn.execute("UPDATE portfolio_records SET created_at=%s,updated_at=%s WHERE owner_id=%s AND id=%s",
                           (funding, funding, owner, record["id"]))

    async def observe(day, rate, received):
        raw = f'{{"amount":1,"base":"USD","date":"{day}","rates":{{"HKD":{rate}}}}}'.encode()
        async with db.connection() as conn, conn.transaction():
            return str(await store_fx(conn, raw, received, uuid4()))

    prior_day, day, next_day = date(2026, 11, 17), date(2026, 11, 18), date(2026, 11, 19)
    history = LicensedHistory(authority, automatic=True)
    await observe(prior_day, "7.8", datetime(2026, 11, 17, 16, tzinfo=UTC))
    prior = await capture_day(db, history, owner, "real", prior_day, now=now)
    assert Decimal(prior["equity"]) == 100
    gap = await capture_day(db, history, owner, "real", day, now=now)
    assert gap["equity"] is None and gap["missing"] == [{"reason": "missing_historical_fx", "currency": "HKD"}]

    fixed_id = await observe(day, "7.5", datetime(2026, 11, 18, 16, tzinfo=UTC))
    first = await capture_day(db, history, owner, "real", day, now=now)
    fixing = first["fx"]["HKD"]
    assert fixing["observationId"] == fixed_id and fixing["frozenAt"] and Decimal(first["pnl"]) == 4
    await observe(day, "8.0", datetime(2026, 11, 18, 21, tzinfo=UTC))
    assert await capture_day(db, history, owner, "real", day, now=now) is None

    await submit(client, command(account, action="external_deposit", amount="75", currency="HKD",
                                 occurredAt="2026-11-18T13:00:00Z"))
    revised = await capture_day(db, history, owner, "real", day, now=now)
    assert revised["revision"] == first["revision"] + 1 and revised["fx"]["HKD"] == fixing
    assert Decimal(revised["equity"]) == 114 and Decimal(revised["externalFlow"]) == 10 and Decimal(revised["pnl"]) == 4

    next_id = await observe(next_day, "8.55", datetime(2026, 11, 19, 16, tzinfo=UTC))
    following = await capture_day(db, history, owner, "real", next_day, now=now)
    assert following["fx"]["HKD"]["observationId"] == next_id and Decimal(following["pnl"]) == -14
