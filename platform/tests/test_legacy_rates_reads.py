"""Read-only legacy FX leaves; explicit refresh remains a separate unproved leaf."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.fx_reference import persist


@pytest.mark.parametrize("path", ["/api/v1/rates", "/api/v2/rates"])
async def test_public_reads_missing_then_pg_snapshot_without_writes(client, app, db, monkeypatch, path):
    service = app.state.reference_rates

    async def forbidden(*args, **kwargs):
        raise AssertionError("a snapshot read must never schedule external work")

    monkeypatch.setattr(service, "submit", forbidden)
    empty = (await client.get(path)).json()["data"]
    assert empty == {"base": "USD", "rates": {"USD": 1}, "quoted": [], "updatedAt": None}
    at = datetime(2026, 1, 3, tzinfo=UTC)
    async with db.connection() as conn, conn.transaction():
        await persist(conn, b'{"amount":1,"base":"USD","date":"2026-01-02","rates":{"HKD":7.8}}', at, uuid4())
        before = await tables_and_hashes(conn)
    response = await client.get(path + "?refresh=0&unknown=ignored")
    assert response.status_code == 200
    assert response.json() == {
        "code": 0,
        "message": "ok",
        "data": {
            "base": "USD",
            "rates": {"USD": 1, "HKD": 7.8},
            "quoted": ["USD", "HKD"],
            "updatedAt": int(at.timestamp() * 1000),
        },
    }
    assert "no-store" in response.headers["cache-control"]
    if path.startswith("/api/v2"):
        assert response.headers["x-alcor-api-version"] == "2"
    async with db.connection() as conn, conn.transaction():
        assert await tables_and_hashes(conn) == before


async def test_web_cookie_bearer_precedence_owner_revocation_and_read_origin(client, settings, db):
    assert (await client.get("/api/rates")).json() == {"error": "未登录"}
    user = await create_user(settings, "RatesReader", "SyntheticReader9", role="user")
    login = await client.post(
        "/api/auth/login", json={"username": "RatesReader", "password": "SyntheticReader9"}
    )
    assert login.status_code == 200
    result = await client.get("/api/rates", headers={"origin": "https://other.invalid"})
    assert result.status_code == 200 and set(result.json()) == {"base", "rates", "quoted", "updatedAt"}
    assert (await client.get("/api/rates", headers={"authorization": "Bearer invalid"})).status_code == 401
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active=false WHERE id=%s", (user,))
    assert (await client.get("/api/rates")).status_code == 401


async def test_v1_ignores_authorization_v2_public_policy_distinguishes_invalid_and_expired(client):
    assert (
        await client.get(
            "/api/v1/rates", headers={"authorization": "invalid", "origin": "https://other.invalid"}
        )
    ).status_code == 200
    for header in ("invalid", "Bearer invalid", "fat_" + "a" * 43):
        response = await client.get("/api/v2/rates", headers={"authorization": header})
        assert response.status_code == 401 and response.json() == {
            "code": 40101,
            "message": "需要有效的 App 连接",
        }
    expired = await client.get("/api/v2/rates", headers={"authorization": "Bearer fat_" + "a" * 43})
    assert expired.status_code == 401 and expired.json() == {
        "code": 40102,
        "message": "连接已失效，请重新连接",
    }
    foreign = await client.get("/api/v2/rates", headers={"origin": "https://other.invalid"})
    assert foreign.status_code == 403 and foreign.json() == {"code": 40301, "message": "请求来源不受信任"}


@pytest.mark.parametrize("path", ["/api/v1/rates", "/api/v2/rates"])
async def test_provider_failure_never_leaks_internal_details(client, app, monkeypatch, path):
    async def broken():
        raise RuntimeError("synthetic private target")

    monkeypatch.setattr(app.state.reference_rates, "snapshot", broken)
    result = await client.get(path)
    assert result.status_code == 502 and result.json() == {
        "code": 50002,
        "message": "获取汇率失败，请稍后重试",
    }


async def test_authenticated_v2_snapshot_does_not_touch_grant_or_schedule_work(
    client, app, db, settings, monkeypatch
):
    from alcor_api.native_app_auth import issue_grant

    uid = await create_user(settings, "RatesGrantReader", "SyntheticReader9", role="user")
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        grant = await issue_grant(conn, user, "portfolio.read", "Synthetic snapshot reader")

    async def forbidden(*args, **kwargs):
        raise AssertionError("authenticated reads must not submit external work")

    monkeypatch.setattr(app.state.reference_rates, "submit", forbidden)
    async with db.connection() as conn, conn.transaction():
        before = await tables_and_hashes(conn)
    response = await client.get("/api/v2/rates", headers={"authorization": "Bearer " + grant["access_token"]})
    assert response.status_code == 200 and response.json()["data"]["updatedAt"] is None
    async with db.connection() as conn, conn.transaction():
        assert await tables_and_hashes(conn) == before
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s", (uid,)
        )
    rejected = await client.get("/api/v2/rates", headers={"authorization": "Bearer " + grant["access_token"]})
    assert rejected.status_code == 401 and rejected.json()["code"] == 40102


async def test_web_snapshot_accepts_explicit_legacy_session_but_not_new_web_cookie(client, app, settings):
    import httpx

    await create_user(settings, "RatesCookieReader", "SyntheticReader9", role="user")
    await client.post(
        "/api/auth/login", json={"username": "RatesCookieReader", "password": "SyntheticReader9"}
    )
    token = client.cookies["fire_session"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        result = await peer.get("/api/rates", headers={"authorization": "Bearer " + token})
        assert result.status_code == 200 and result.json()["updatedAt"] is None
        assert (
            await peer.post(
                "/api/session/login", json={"login": "RatesCookieReader", "password": "SyntheticReader9"}
            )
        ).status_code == 200
        assert (await peer.get("/api/rates")).status_code == 401
