import hashlib
import json
from pathlib import Path

import pytest
from alcor_api.market_calendar import BUILTIN_PATH, Calendars

HERE = Path(__file__).parent


@pytest.mark.asyncio
async def test_pg_calendar_full_golden_and_http(db, client):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
    raw = BUILTIN_PATH.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    store = Calendars(db)
    revision = await store.import_release(raw, sha)
    assert await store.import_release(raw, sha) == revision
    golden = json.loads(raw)
    for batch in golden["years"]:
        actual = await store.batch(batch["year"])
        for cal in batch["calendars"].values():
            cal["sources"].sort(key=lambda s: s["id"])
        assert actual == batch
    bad = raw.replace(b"2026-10-02.1", b"2026-10-02.1", 1) + b" "
    with pytest.raises(ValueError):
        await store.import_release(bad, hashlib.sha256(bad).hexdigest())
    response = await client.get("/api/v2/market-calendar?market=HK&year=2026")
    assert response.status_code == 200
    days = {d["date"]: d for d in response.json()["data"]["days"]}
    assert days["2026-12-24"]["close"]["auction"] == {
        "earliest": "12:08",
        "latest": "12:10",
        "appliesTo": "CAS_securities",
    }
    assert (
        await client.get(
            "/api/v2/market-calendar?market=HK&year=2026",
            headers={"if-none-match": "W/" + response.headers["etag"]},
        )
    ).status_code == 304
    for suffix in ("?market=US&year=2026&year=2027", "?market=UK&year=2026", "/batch?year=2026&market=US"):
        assert (await client.get("/api/v2/market-calendar" + suffix)).status_code == 400
    unknown = (await client.get("/api/v2/market-calendar/batch?year=2028")).json()["data"]
    assert all(d["status"] == "unknown" for c in unknown["calendars"].values() for d in c["days"])


@pytest.mark.asyncio
async def test_calendar_revision_publication_and_invalid_source_rollback(db):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
    store = Calendars(db)
    raw = BUILTIN_PATH.read_bytes()
    original = await store.import_release(raw, hashlib.sha256(raw).hexdigest())
    revised = raw.replace(original.encode(), b"2026-11-01.1")
    await store.import_release(revised, hashlib.sha256(revised).hexdigest())
    assert (await store.batch(2026))["calendarVersion"] == original
    await store.activate("2026-11-01.1", original)
    assert (await store.batch(2026))["calendarVersion"] == "2026-11-01.1"
    with pytest.raises(ValueError):
        await store.activate(original, original)
    corrupted = json.loads(raw.replace(original.encode(), b"bad-source"))
    corrupted["years"][0]["calendars"]["HK"]["days"][0]["actualTradingStatus"] = "open"
    invalid = json.dumps(corrupted).encode()
    with pytest.raises(ValueError):
        await store.import_release(invalid, hashlib.sha256(invalid).hexdigest())
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM market_calendar_releases WHERE revision='bad-source'")
        ).fetchone()


@pytest.mark.asyncio
async def test_calendar_source_metadata_and_original_bytes_are_immutable(db):
    from psycopg.errors import RaiseException

    service = Calendars(db)
    revision = await service.ensure_builtin()
    for table, clause in [
        ("market_calendar_releases", "original_bytes=original_bytes"),
        ("market_calendar_markets", "name=name"),
        ("market_calendar_years", "verified_at=verified_at"),
        ("market_calendar_sources", "url=url"),
        ("market_calendar_days", "name=name"),
    ]:
        async with db.connection() as conn:
            with pytest.raises(RaiseException):
                async with conn.transaction():
                    await conn.execute(f"UPDATE {table} SET {clause} WHERE revision=%s", (revision,))


@pytest.mark.asyncio
async def test_native_discovery_matches_actual_calendar_version(client, db):
    await Calendars(db).ensure_builtin()
    for version in (1, 2):
        response = await client.get(f"/api/v{version}/auth/config")
        assert response.status_code == 200
        config = response.json()["data"]["market_calendar"]
        batch = (await client.get(config["batch_path"] + "?year=2026")).json()["data"]
        assert config["calendar_version"] == batch["calendarVersion"]
        assert set(batch["calendars"]) == {m["market"] for m in config["markets"]}


@pytest.mark.asyncio
async def test_calendar_canonical_cookie_boundary_and_cache(client, db, admin):
    await Calendars(db).ensure_builtin()
    descriptor = (await client.get('/api/reference/calendar/discovery')).json()
    assert descriptor['path'] == '/api/reference/calendar'
    assert descriptor['batch_path'] == '/api/reference/calendar/batch'
    assert 'api_version' not in descriptor
    for suffix in ('?market=HK&year=2026', '/batch?year=2026'):
        response = await client.get('/api/reference/calendar' + suffix)
        assert response.status_code == 200
        assert 'no-store' in response.headers['cache-control']
        if suffix.startswith('/batch'):
            assert set(response.json()['data']['calendars']) == {'CN', 'HK', 'US'}
        # Private response never becomes a shared calendar cache entry, including 304.
        cached = await client.get('/api/reference/calendar' + suffix,
                                  headers={'If-None-Match': response.headers['etag']})
        assert cached.status_code == 304
        assert 'no-store' in cached.headers['cache-control']
    client.cookies.clear()
    for suffix in ('?market=HK&year=2026', '/batch?year=2026'):
        response = await client.get('/api/reference/calendar' + suffix)
        assert response.status_code == 401
        assert 'no-store' in response.headers['cache-control']
        public = await client.get('/api/v2/market-calendar' + suffix)
        assert public.status_code == 200
        assert public.headers['cache-control'] == 'public, max-age=300, must-revalidate'
        assert public.headers['vary'] == 'Origin, Authorization'
        cached = await client.get('/api/v2/market-calendar' + suffix,
                                  headers={'If-None-Match': public.headers['etag']})
        assert cached.status_code == 304
        assert cached.headers['cache-control'] == public.headers['cache-control']
        rejected = await client.get('/api/v2/market-calendar' + suffix,
                                    headers={'Authorization': 'Bearer invalid'})
        assert rejected.status_code == 401
        assert 'no-store' in rejected.headers['cache-control']


@pytest.mark.asyncio
async def test_canonical_calendar_native_grant_is_independent_from_cookie(client, admin, db):
    from alcor_api.native_app_auth import issue_grant

    await Calendars(db).ensure_builtin()
    async with db.connection() as conn:
        user = await (await conn.execute('SELECT * FROM users WHERE id=%s', (admin,))).fetchone()
        pair = await issue_grant(conn, user, 'portfolio.read', 'Synthetic calendar client')
    path = '/api/reference/calendar/batch?year=2026'
    # Explicit invalid Bearer never falls back to an otherwise valid Cookie.
    assert (await client.get(path, headers={'Authorization': 'Bearer invalid'})).status_code == 401
    client.cookies.clear()
    result = await client.get(path, headers={'Authorization': 'Bearer ' + pair['access_token']})
    assert result.status_code == 200
    assert set(result.json()['data']['calendars']) == {'CN', 'HK', 'US'}
    assert 'no-store' in result.headers['cache-control']
    async with db.connection() as conn:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s', (pair['grant_id'],))
    assert (await client.get(path, headers={'Authorization': 'Bearer ' + pair['access_token']})).status_code == 401
