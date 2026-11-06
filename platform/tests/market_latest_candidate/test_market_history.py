"""Explicit licensed history only; actual PG and bounded isolated SDK objects."""

from dataclasses import asdict, replace
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alcor_api.market_authority import Authority, Policy
from alcor_api.market_contract import Query, canonical
from alcor_api.market_futu_sdk import collect
from alcor_api.market_worker import claim, execute, schedule
from fastapi import HTTPException

from .test_market_authority import demand, market, market_settings, read  # noqa: F401
from .test_market_sdk import ENUMS, Context


def query(frame="day"):
    return Query("bars", "US", "AAPL", frame, "qfq", start="2026-10-01", through="2026-10-31")


@pytest.mark.parametrize("frame", ["day", "month"])
def test_monthly_sdk_uses_real_month_enum_original_cursor_and_closes(frame):
    context = Context()
    enums = {**ENUMS, "KLType": SimpleNamespace(K_DAY="source-day", K_MON="source-month")}
    result = collect(
        lambda **_: context,
        0,
        {
            "action": "history",
            "host": "controlled",
            "port": 1234,
            "symbols": ["US.AAPL"],
            "query": asdict(query(frame)),
            "cursor": None,
        },
        enums,
    )
    assert context.calls[0][2]["ktype"] == "source-" + frame
    assert "session" not in context.calls[0][2]
    assert context.calls[0][2]["extended_time"] is False
    assert context.calls[0][2]["autype"] == "source-qfq"
    assert context.calls[0][2]["max_count"] == 100 and context.closed
    assert result["nextCursor"] is not None


class History:
    fixture = True

    def __init__(self):
        self.cursors = []
        self.hook = None

    async def read(self, policy, query, cursor):
        self.cursors.append(cursor)
        if self.hook:
            await self.hook()
        facts = [
            {
                "at": "2026-10-19T04:00:00+00:00",
                "o": "99",
                "h": "110",
                "l": "90",
                "c": "100" if cursor is None else "101",
                "currency": "USD",
            }
        ]
        if cursor is not None:
            facts.append(
                {
                    "at": "2026-10-20T04:00:00+00:00",
                    "o": "100",
                    "h": "110",
                    "l": "90",
                    "c": "102",
                    "currency": "USD",
                    "v": "0",
                }
            )
        return canonical(
            {
                "query": asdict(query),
                "licenseRevision": policy.license_revision,
                "facts": facts,
                "nextCursor": "source-page-2" if cursor is None else None,
            }
        ).encode(), "controlled_source_body"


async def test_daily_history_terminal_pages_corrections_and_missing_volume_remain_real(market):  # noqa: F811
    client, app, authority, _, revision = market
    q = query()
    registered = await demand(client, revision, q)
    history = History()
    assert await schedule(authority) == 1
    first = await claim(authority.db, uuid4(), kind="market.history")
    assert first and await execute(authority, first, history) == "more"
    partial = (await read(client, revision, q)).json()
    assert partial["coverage"] == "unknown" and partial["facts"][0]["c"] == "100"
    second = await claim(authority.db, uuid4(), kind="market.history")
    assert second["id"] == first["id"]
    assert await execute(authority, second, history) == "complete"
    result = (await read(client, revision, q)).json()
    assert [row["c"] for row in result["facts"]] == ["101", "102"]
    assert "v" not in result["facts"][0] and result["facts"][1]["v"] == "0"
    assert result["coverage"] == "controlled_terminal_pages"
    assert result["fullBusinessHistoryVerified"] is False
    assert history.cursors == [None, "source-page-2"]
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_facts")).fetchone())["n"] == 3
        pages = await (
            await conn.execute("SELECT raw_bytes,raw_sha256 FROM market_source_pages ORDER BY page_number")
        ).fetchall()
        assert len(pages) == 2 and all(row["raw_bytes"] and row["raw_sha256"] for row in pages)
    receipt = await client.get("/api/market/operations/" + registered["requestId"])
    assert receipt.status_code == 200
    assert await schedule(authority) == 0
    assert await claim(authority.db, uuid4(), kind="market.history") is None
    replay = await client.post(
        "/api/market/demands",
        json={
            "request_id": registered["requestId"],
            "source_revision": revision,
            "query": asdict(q),
            "expected_revision": 0,
        },
    )
    assert replay.status_code == 200 and replay.json() == registered
    assert await schedule(authority) == 0
    renewed = await demand(client, revision, q, expected=registered["revision"])
    assert renewed["revision"] == registered["revision"] + 1
    assert await schedule(authority) == 1
    refresh = await claim(authority.db, uuid4(), kind="market.history")
    assert refresh["id"] != first["id"]
    assert await execute(authority, refresh, history) == "more"
    terminal = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, terminal, history) == "complete"
    assert await schedule(authority) == 0
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_facts")).fetchone())["n"] == 3
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_source_pages")).fetchone())[
            "n"
        ] == 4
        coverage = await (await conn.execute("SELECT point_count FROM market_coverage_receipts")).fetchall()
        assert len(coverage) == 2 and all(row["point_count"] == 2 for row in coverage)


def test_history_exact_purpose_and_semantics_do_not_inherit_latest_license():
    authority = Authority(SimpleNamespace(settings=SimpleNamespace(environment="test")))
    policy = Policy(
        "explicit",
        "controlled_market",
        "captured-v1",
        "fixture",
        "f" * 64,
        "owner",
        "license-v1",
        ("latest", "bars.day", "bars.month"),
        ("US",),
        fixture=True,
    )
    for purposes, q, status in [
        (("latest",), query(), 403),
        ("prefix-bars.day-suffix", query(), 403),
        (("bars.day",), query("month"), 403),
        (("bars.month",), query("month"), None),
        (("bars.day",), replace(query(), frame="minute"), 403),
        (("bars.day",), replace(query(), session="ALL"), 503),
        (("bars.day",), replace(query(), instrument="index"), 503),
    ]:
        selected = replace(policy, purposes=purposes)
        if status is None:
            authority.validate_query(selected, q)
        else:
            with pytest.raises(HTTPException) as exc:
                authority.validate_query(selected, q)
            assert exc.value.status_code == status
    unsupported = replace(policy, fixture=False, source="other")
    with pytest.raises(HTTPException):
        authority.validate_query(unsupported, query())


async def test_empty_history_terminal_is_known_empty_source_page_not_full_history(market):  # noqa: F811
    client, app, authority, _, revision = market
    q = query("month")
    await demand(client, revision, q)

    class Empty:
        fixture = True

        async def read(self, policy, query, cursor):
            return canonical(
                {
                    "query": asdict(query),
                    "licenseRevision": policy.license_revision,
                    "facts": [],
                    "nextCursor": None,
                }
            ).encode(), "controlled_source_body"

    await schedule(authority)
    task = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, task, Empty()) == "complete"
    result = (await read(client, revision, q)).json()
    assert result["facts"] == [] and result["state"] == "unknown"
    assert result["coverage"] == "controlled_terminal_pages_empty"
    assert result["fullBusinessHistoryVerified"] is False
    async with app.state.db.connection() as conn:
        receipt = await (await conn.execute("SELECT * FROM market_coverage_receipts")).fetchone()
        assert receipt["point_count"] == 0 and len(receipt["page_ids"]) == 1
    from datetime import UTC, datetime

    authority.clock = lambda: datetime(2026, 10, 1, tzinfo=UTC)
    future_query = query("day")
    await demand(client, revision, future_query)

    class Future:
        fixture = True

        async def read(self, policy, query, cursor):
            fact = {
                "at": "2026-10-19T04:00:00+00:00",
                "o": "99",
                "h": "100",
                "l": "99",
                "c": "100",
                "currency": "USD",
            }
            return canonical(
                {
                    "query": asdict(query),
                    "licenseRevision": policy.license_revision,
                    "facts": [fact],
                    "nextCursor": None,
                }
            ).encode(), "controlled_source_body"

    await schedule(authority)
    task = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, task, Future()) == "complete"
    future = (await read(client, revision, future_query)).json()
    assert future["facts"] == [] and future["coverage"] == "controlled_terminal_pages_empty_partial_records"
    async with app.state.db.connection() as conn:
        page = await (
            await conn.execute("SELECT issues FROM market_source_pages WHERE task_id=%s", (task["id"],))
        ).fetchone()
        assert page["issues"] == [{"reason": "source_future_observation", "at": "2026-10-19T04:00:00+00:00"}]


async def test_revoke_during_history_page_keeps_prior_facts_and_original_pages(market):  # noqa: F811
    client, app, authority, _, revision = market
    q = query()
    await demand(client, revision, q)
    history = History()
    await schedule(authority)
    first = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, first, history) == "more"

    async def revoke():
        response = await client.request(
            "DELETE", "/api/market/sources/" + revision, json={"request_id": str(uuid4())}
        )
        assert response.status_code == 200

    history.hook = revoke
    second = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, second, history) == "cancelled"
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_facts")).fetchone())["n"] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_source_pages")).fetchone())[
            "n"
        ] == 2
        pages=await(await conn.execute("SELECT raw_bytes,raw_sha256 FROM market_source_pages ORDER BY page_number")).fetchall()
        import hashlib
        assert len(pages)==2 and all(hashlib.sha256(bytes(page["raw_bytes"])).hexdigest()==page["raw_sha256"] for page in pages)
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_coverage_receipts")).fetchone())[
            "n"
        ] == 0
    assert history.cursors == [None, "source-page-2"]
    await execute(authority,second,history)
    assert history.cursors == [None, "source-page-2"]
    assert await schedule(authority) == 0


async def test_runtime_prioritizes_latest_before_one_bounded_history_page(monkeypatch):
    import alcor_api.market_runtime as runtime

    calls = []
    latest = {"id": uuid4()}
    history = {"id": uuid4()}
    state = {"latest": latest}

    async def noop(*args):
        pass

    async def pick(db, worker, *, kind):
        calls.append(kind)
        return state["latest"] if kind == "market.latest" else history

    async def execute_one(authority, task, transport):
        return "observed" if task is latest else "more"

    monkeypatch.setattr(runtime, "project_alert_demands", noop)
    monkeypatch.setattr(runtime, "schedule", noop)
    monkeypatch.setattr(runtime, "claim", pick)
    monkeypatch.setattr(runtime, "execute", execute_one)
    assert (await runtime.cycle(SimpleNamespace(db=None), None, uuid4()))["state"] == "observed"
    assert calls == ["market.latest"]
    calls.clear()
    state["latest"] = None
    assert (await runtime.cycle(SimpleNamespace(db=None), None, uuid4()))["state"] == "more"
    assert calls == ["market.latest", "market.history"]


def test_history_controlled_rows_enforce_requested_window_and_do_not_fill_missing_volume():
    from alcor_api.market_worker import decode

    policy = SimpleNamespace(
        source="controlled_market", source_version="captured-v1", fixture=True, license_revision="approved-v1"
    )
    q = query()
    raw = canonical(
        {
            "query": asdict(q),
            "licenseRevision": policy.license_revision,
            "nextCursor": None,
            "facts": [
                {
                    "at": "2026-09-30T04:00:00+00:00",
                    "o": "1",
                    "h": "2",
                    "l": "1",
                    "c": "2",
                    "currency": "USD",
                },
                {
                    "at": "2026-10-01T04:00:00+00:00",
                    "o": "1",
                    "h": "2",
                    "l": "1",
                    "c": "2",
                    "currency": "USD",
                },
            ],
        }
    ).encode()
    facts, issues, cursor = decode(policy, q, raw)
    assert len(facts) == len(issues) == 1 and cursor is None
    assert facts[0]["at"].startswith("2026-10-01") and "v" not in facts[0]


async def test_history_transport_only_spawns_pinned_readonly_sdk_for_exact_license(monkeypatch):
    import alcor_api.market_transport as transport_module
    from alcor_api.dividend_sources import Target

    target = Target(
        "source",
        "futu",
        "controlled.invalid",
        1234,
        ("127.0.0.1",),
        approved_access=True,
        fixture=True,
        scheme="http",
        allow_plaintext=True,
    )
    policy = Policy(
        "licensed",
        "futu",
        "futu-sdk-records-v1",
        target.id,
        target.fingerprint,
        "owner",
        "approved-v1",
        ("bars.day", "bars.month"),
        ("US",),
    )
    captured = []

    class Writer:
        def write(self, value):
            captured.append(value)

        async def drain(self):
            pass

        def close(self):
            pass

    class Reader:
        async def read(self, limit):
            assert limit == 131073
            return b'{"records":[],"nextCursor":null}'

    class Process:
        stdin = Writer()
        stdout = Reader()
        returncode = None

        async def wait(self):
            self.returncode = 0

        def kill(self):
            raise AssertionError("Already completed")

    async def spawn(*args, **kwargs):
        assert args[1] == "-I" and args[2].endswith("market_futu_sdk.py")
        return Process()

    async def resolve(host, port):
        assert host == "controlled.invalid" and port == 1234
        return ("127.0.0.1",)

    monkeypatch.setattr(transport_module.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(transport_module, "resolve", resolve)
    service = transport_module.Transport(
        SimpleNamespace(settings=SimpleNamespace(environment="test")), (target,)
    )
    raw, representation = await service.read(policy, query("month"), "b3JpZ2luYWw=")
    payload = __import__("json").loads(captured[0])
    assert payload["action"] == "history" and payload["query"]["frame"] == "month"
    assert payload["host"] == "127.0.0.1" and payload["cursor"] == "b3JpZ2luYWw="
    assert raw and representation == "sdk_json_representation_not_wire_bytes"
    for rejected in (replace(policy, purposes=("latest",)), replace(policy, markets=("HK",))):
        with pytest.raises(ValueError, match="source_protocol_not_installed"):
            await service.read(rejected, query("month"), None)
    assert len(captured) == 1


async def test_day_and_month_source_frames_never_share_fact_series(market):  # noqa: F811
    client, _, authority, _, revision = market
    await demand(client, revision, query("day"))
    await demand(client, revision, query("month"))

    class Frames:
        fixture = True

        async def read(self, policy, query, cursor):
            close = "102" if query.frame == "day" else "503"
            fact = {
                "at": "2026-10-01T04:00:00+00:00",
                "o": close,
                "h": close,
                "l": close,
                "c": close,
                "currency": "USD",
            }
            return canonical(
                {
                    "query": asdict(query),
                    "licenseRevision": policy.license_revision,
                    "facts": [fact],
                    "nextCursor": None,
                }
            ).encode(), "controlled_source_body"

    assert await schedule(authority) == 2
    for _ in range(2):
        task = await claim(authority.db, uuid4(), kind="market.history")
        assert task and await execute(authority, task, Frames()) == "complete"
    day = (await read(client, revision, query("day"))).json()
    month = (await read(client, revision, query("month"))).json()
    assert day["facts"][0]["c"] == "102" and month["facts"][0]["c"] == "503"
    assert day["streamId"] != month["streamId"]
    assert day["coverage"] == month["coverage"] == "controlled_terminal_pages"
    async with authority.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET expires_at=clock_timestamp()-interval '1 second'")
    assert await schedule(authority) == 0
    assert (await read(client, revision, query("day"))).json()["facts"] == day["facts"]
    assert (await read(client, revision, query("month"))).json()["coverage"] == month["coverage"]
    async with authority.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_coverage_receipts")).fetchone())[
            "n"
        ] == 2


def test_normal_history_fields_fit_bounded_page_without_enlarging_source_budget():
    import json

    record = {
        "code": "US.DEMO",
        "name": "公开来源协议向量",
        "time_key": "2026-10-01 00:00:00",
        "open": 52.631194,
        "close": 53.963447,
        "high": 53.992409,
        "low": 52.549135,
        "pe_ratio": 18.773,
        "turnover_rate": 0.01039,
        "volume": 177158584.0,
        "turnover": 9.808562e9,
        "change_rate": 3.179511,
        "last_close": 52.300545,
    }

    class Rows:
        def __init__(self, count):
            self.count = count

        def to_dict(self, orient):
            assert orient == "records"
            return [record] * self.count

    class Bounded(Context):
        def request_history_kline(self, symbol, **kwargs):
            self.calls.append(("history", symbol, kwargs))
            return 0, Rows(kwargs["max_count"]), b"original-next-page"

    context = Bounded()
    result = collect(
        lambda **_: context,
        0,
        {
            "action": "history",
            "host": "controlled",
            "port": 1234,
            "symbols": ["US.DEMO"],
            "query": asdict(replace(query(), code="DEMO")),
            "cursor": None,
        },
        ENUMS,
    )
    assert len(result["records"]) == 100 and context.closed

    def encoded(value):
        return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())

    assert encoded(result) < 131072
    assert encoded({"records": [record] * 500, "nextCursor": None}) > 131072


@pytest.mark.parametrize("cursor", ["", __import__("base64").b64encode(b"x" * 65537).decode()])
def test_sdk_cursor_decoded_byte_limit_rejects_without_history_request(cursor):
    context = Context()
    with pytest.raises(ValueError, match="sdk_cursor_invalid"):
        collect(
            lambda **_: context,
            0,
            {
                "action": "history",
                "host": "controlled",
                "port": 1234,
                "symbols": ["US.AAPL"],
                "query": asdict(query()),
                "cursor": cursor,
            },
            ENUMS,
        )
    assert context.closed and not context.calls


async def test_owner_source_descriptors_read_purity_and_expired_demand_cas_ui_path(market):  # noqa: F811
    client, app, _authority, transport, revision = market

    async def state():
        async with app.state.db.connection() as conn:
            tables = await (
                await conn.execute(
                    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'market_%' ORDER BY tablename"
                )
            ).fetchall()
            return {
                row["tablename"]: await (
                    await conn.execute(
                        "SELECT md5(COALESCE(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text),'')) AS hash FROM "
                        + row["tablename"]
                        + " r"
                    )
                ).fetchone()
                for row in tables
            }

    before = await state()
    descriptor = await client.get("/api/market/sources")
    assert descriptor.status_code == 200, descriptor.text
    body = descriptor.json()
    assert body["automaticCollection"] is False
    assert body["policies"][0]["historyFrames"] == ["day", "month"]
    assert not (
        {"target_id", "target_fingerprint", "host", "port", "addresses", "native_grant_id"}
        & set(body["policies"][0])
    )
    assert body["versions"][0]["revision"] == revision and body["versions"][0]["usable"]
    assert await state() == before and transport.calls == 0
    q = query()
    await demand(client, revision, q)
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET expires_at=clock_timestamp()-interval '1 second'")
    assert (await client.get("/api/market/demands")).json()["items"] == []
    listing = await client.get("/api/market/demands?include_inactive=1")
    row = listing.json()["items"][0]
    assert row["active"] is False and row["cancellable"] is True and row["revision"] == 1
    renewed = await demand(client, revision, q, expected=row["revision"])
    assert renewed["revision"] == 2 and transport.calls == 0
