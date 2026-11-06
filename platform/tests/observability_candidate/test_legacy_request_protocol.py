"""Old request-log cookies keep the reviewed numeric envelope."""

import json
from uuid import uuid4

import httpx
import pytest
from alcor_api.cli import create_user
from alcor_api.request_observability import rollup
from alcor_api.request_observability_api import snapshot
from alcor_api.security import digest
from fastapi import HTTPException
from starlette.requests import Request

ALLOWED = {
    "revision",
    "today",
    "summary",
    "chart",
    "chartUnit",
    "endpoints",
    "logs",
    "pagination",
    "heatmap",
    "detailFrom",
}
REMOVED = {
    "aggregateRevision",
    "detailFloor",
    "detailGap",
    "observedOnly",
    "lostBuffered",
    "crashLossKnown",
    "rollupPending",
    "legacyImport",
    "localCollector",
}


def open_client(app, **headers):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver", "accept": "*/*", **headers},
    )


async def legacy_session(app, db, settings, *, role, name, cookie="fire_session"):
    user_id = await create_user(settings, name, "Synthetic9Pass", role=role)
    token = name.encode().hex().ljust(64, "a")[:64]
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at)
               SELECT %s,%s,'legacy-web',session_version,clock_timestamp()+interval '1 day'
               FROM users WHERE id=%s""",
            (digest(token), user_id, user_id),
        )
    client = open_client(app)
    client.cookies.set(cookie, token)
    return client, user_id


def request_for(app, client, path="/api/request-logs/events"):
    cookie = "; ".join(f"{key}={value}" for key, value in client.cookies.items())
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "query_string": b"",
            "headers": [
                (b"host", b"testserver"),
                (b"cookie", cookie.encode()),
                (b"origin", b"http://testserver"),
            ],
            "server": ("testserver", 80),
            "app": app,
        }
    )


async def lease_count(db):
    async with db.connection() as conn:
        return (await (await conn.execute("SELECT count(*) AS n FROM request_stream_leases")).fetchone())["n"]


async def test_old_cookie_snapshot_keeps_reviewed_keys_and_auth(client, admin, app, db, settings):
    assert admin
    legacy, _ = await legacy_session(app, db, settings, role="admin", name="RequestAdmin")
    user, _ = await legacy_session(
        app, db, settings, role="user", name="RequestUser", cookie="stocklog_session"
    )
    anonymous = open_client(app)
    try:
        plain = await anonymous.get("/api/request-logs")
        assert plain.status_code == 401 and "error" in plain.json() and "code" not in plain.json()
        assert (await anonymous.get("/api/request-logs/events")).status_code == 401
        anonymous.cookies.set("fire_session", "")
        for path in ("/api/request-logs", "/api/request-logs/events"):
            empty = await anonymous.get(path)
            assert empty.status_code == 401 and empty.json() == {"code": 40101, "message": "未登录"}
        anonymous.cookies.clear()
        anonymous.cookies.set("stocklog_session", "not-a-session")
        invalid = await anonymous.get("/api/request-logs")
        assert invalid.status_code == 401 and invalid.json() == {"code": 40101, "message": "未登录"}
        denied = await user.get("/api/request-logs")
        assert denied.status_code == 403 and denied.json() == {"code": 40301, "message": "需要管理员权限"}
        denied_events = await user.get("/api/request-logs/events")
        assert denied_events.status_code == 403 and denied_events.json() == {
            "code": 40301,
            "message": "需要管理员权限",
        }
        fat = {"authorization": "Bearer fat_" + "a" * 43}
        for path in ("/api/request-logs", "/api/request-logs/events"):
            blocked = await legacy.get(path, headers=fat)
            assert blocked.status_code == 401 and blocked.json() == {"code": 40101, "message": "未登录"}

        app.state.request_observations.record("/api/records/{record_id}", "GET", "ios", 499, 12)
        app.state.request_observations.record("/api/account/state", "GET", "web", 503, 6)
        await app.state.request_observations.flush()
        await rollup(db)
        filtered = await legacy.get(
            "/api/request-logs",
            params={"rStatus": "cancelled", "rSource": "ios", "rQ": "records"},
            headers={"origin": "http://evil.example"},
        )
        assert filtered.status_code == 200, filtered.text
        assert "no-store" in filtered.headers["cache-control"]
        body = filtered.json()
        assert body["code"] == 0 and body["message"] == "ok" and set(body) == {"code", "message", "data"}
        assert set(body["data"]) == ALLOWED and REMOVED.isdisjoint(body["data"])
        assert body["data"]["summary"]["total"] == 1 and body["data"]["logs"][0]["status"] == 499
        async with db.connection() as conn:
            expected = await snapshot(conn, {"rStatus": "cancelled", "rSource": "ios", "rQ": "records"})
        assert body["data"]["summary"] == expected["summary"]
        assert body["data"]["revision"] == expected["revision"]
        missed = await legacy.get("/api/request-logs", params={"rStatus": "4xx"})
        assert missed.json()["code"] == 0 and missed.json()["data"]["summary"]["total"] == 0
        assert set(missed.json()["data"]) == ALLOWED

        client.cookies.set("fire_session", "platform-wins")
        kept = await client.get("/api/request-logs")
        assert kept.status_code == 200, kept.text
        platform = kept.json()["data"]
        assert "legacyImport" in platform and "localCollector" in platform
        assert platform["legacyImport"]["historicalCoverageKnown"] is False
        assert platform["legacyImport"]["hourDurationKnown"] is False
        assert await lease_count(db) == 0
    finally:
        await legacy.aclose()
        await user.aclose()
        await anonymous.aclose()


async def test_old_event_stream_frames_cap_and_alcor_exception(client, admin, app, db, settings, monkeypatch):
    import alcor_api.request_observability_api as module

    monkeypatch.setattr(module, "STREAM_POLL_SECONDS", 0.05)
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", "") == "/api/request-logs/events")
    legacy, user_id = await legacy_session(app, db, settings, role="admin", name="StreamAdmin")
    inserted = []
    iterator = None
    try:
        response = await endpoint(request_for(app, legacy))
        assert response.headers["content-type"].startswith("text/event-stream")
        assert "no-store" in response.headers["cache-control"]
        assert response.headers["x-accel-buffering"] == "no"
        iterator = response.body_iterator
        first = await anext(iterator)
        second = await anext(iterator)
        assert first.startswith("event: change\ndata: ") and first.endswith("\n\n")
        assert second == ": heartbeat\n\n"
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (user_id,))
        with pytest.raises(StopAsyncIteration):
            await anext(iterator)
        iterator = None
        assert await lease_count(db) == 0
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET session_version=session_version-1 WHERE id=%s", (user_id,))
            for _ in range(20):
                lease = uuid4()
                inserted.append(lease)
                await conn.execute(
                    "INSERT INTO request_stream_leases VALUES(%s,clock_timestamp()+interval '30 seconds')",
                    (lease,),
                )
        denied = await endpoint(request_for(app, legacy))
        assert denied.status_code == 429
        assert json.loads(denied.body) == {"code": 42901, "message": "实时连接过多"}
        with pytest.raises(HTTPException) as raised:
            await endpoint(request_for(app, client))
        assert raised.value.status_code == 429 and raised.value.detail == "实时连接过多"
    finally:
        if iterator is not None:
            await iterator.aclose()
        await legacy.aclose()
        if inserted:
            async with db.connection() as conn:
                for lease in inserted:
                    await conn.execute("DELETE FROM request_stream_leases WHERE id=%s", (lease,))
    assert await lease_count(db) == 0
