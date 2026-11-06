from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from alcor_api.fx_reference import FxWorker, parse_raw, persist
from alcor_api.fx_service import ManagedFx

RAW = b'{"amount":1,"base":"USD","date":"2026-01-02","rates":{"JPY":150.12345678901234,"HKD":7.8}}'


@pytest.mark.asyncio
async def test_disabled_default_and_durable_original_uuid(db, settings):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
    calls = []

    async def respond(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=RAW)

    transport = httpx.MockTransport(respond)
    disabled = ManagedFx(db, transport=transport)
    identifier = uuid4()
    assert await disabled.once() == "disabled" and calls == []
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    worker = ManagedFx(db, transport=transport)
    await worker.submit("public:synthetic", identifier)
    assert await worker.once() == "completed"
    receipt = await worker.receipt("public:synthetic", identifier)
    assert receipt["state"] == "completed" and await worker.once() == "idle" and (len(calls) == 1)
    snap = await worker.snapshot()
    assert snap["observationDate"] == "2026-01-02" and "CNY" not in snap["rates"]
    assert snap["updatedAt"] is not None
    async with db.connection() as conn, conn.transaction():
        at = datetime.now(UTC)
        old = RAW.replace(b"2026-01-02", b"2026-01-01")
        key = uuid4()
        await persist(conn, old, at, key)
        assert await persist(conn, old, at, key) == key
        with pytest.raises(ValueError):
            await persist(conn, old, at + timedelta(seconds=1), key)
    assert (await worker.snapshot())["observationDate"] == "2026-01-02"


def test_provider_timestamp_precision_and_invalid_payload():
    value = parse_raw(RAW, datetime(2026, 1, 3, tzinfo=UTC))
    assert value["date"].isoformat() == "2026-01-02"
    assert str(value["rates"]["JPY"]) == "150.12345678901234"
    for raw in [
        RAW.replace(b'"base":"USD"', b'"base":"EUR"'),
        RAW.replace(b"7.8", b"0"),
        RAW.replace(b"7.8", b"NaN"),
        RAW[:-1] + b',"base":"USD"}',
    ]:
        with pytest.raises(ValueError):
            parse_raw(raw, datetime(2026, 1, 3, tzinfo=UTC))


@pytest.mark.parametrize(
    "raw",
    [
        b"[]",
        b"null",
        RAW.replace(b'"amount":1', b'"amount":true'),
        RAW.replace(b"2026-01-02", b"20260102"),
        RAW.replace(b'"rates":{', b'"rates":['),
    ],
)
def test_provider_rejects_non_contract_shapes(raw):
    with pytest.raises((ValueError, TypeError)):
        parse_raw(raw, datetime(2026, 1, 3, tzinfo=UTC))


@pytest.mark.asyncio
async def test_same_quote_new_fetch_keeps_receipt_time(db):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
        first = datetime(2026, 1, 3, tzinfo=UTC)
        second = first + timedelta(hours=1)
        async with conn.transaction():
            await persist(conn, RAW, first, uuid4())
            await persist(conn, RAW, second, uuid4())
    snapshot = await FxWorker(db).snapshot()
    assert snapshot["updatedAt"] == int(second.timestamp() * 1000)
    assert snapshot["observationDate"] == "2026-01-02"
