from dataclasses import asdict
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

from alcor_api.fx_reference import persist as store_fx
from alcor_api.market_calendar import Calendars
from alcor_api.market_contract import Query, canonical
from alcor_api.market_history_reads import LicensedHistory
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.personal_data_transfer import digest
from alcor_api.portfolio_daily import capture_day, capture_due
from test_cash_ledger import command, submit
from test_trading import setup

from .test_market_authority import demand, market, market_settings  # noqa: F401


class DailySource:
    fixture = True

    async def read(self, policy, query, cursor):
        facts = [{"at": at, "o": "99", "h": "110", "l": "90", "c": price, "currency": "USD"}
                 for at, price in [("2026-10-19T04:00:00+00:00", "100"), ("2026-10-20T04:00:00+00:00", "103")]]
        return canonical({"query": asdict(query), "licenseRevision": policy.license_revision,
                          "facts": facts, "nextCursor": None}).encode(), "controlled_source_body"


async def test_daily_results_retain_exact_inputs_keep_versions_and_explain_a_gap(market):  # noqa: F811
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
