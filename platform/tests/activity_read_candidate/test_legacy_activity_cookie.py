"""Old activity cookies keep the reviewed read. An Alcor session keeps origin rejection."""

import httpx
from alcor_api.cli import create_user
from alcor_api.security import digest

FIELDS = {"id", "event", "detail", "ip", "createdAt", "userName"}


def open_client(app, **headers):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver", **headers},
    )


async def legacy_client(app, db, settings, *, role, name, cookie):
    user_id = await create_user(settings, name, "Synthetic9Pass", role=role)
    token = name.encode().hex().ljust(64, "a")[:64]
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at)
               SELECT %s,%s,'legacy-web',session_version,clock_timestamp()+interval '1 day'
               FROM users WHERE id=%s""",
            (digest(token), user_id, user_id),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,%s,%s)",
            (user_id, "synthetic." + role, name + "-only"),
        )
    client = open_client(app)
    client.cookies.set(cookie, token)
    return client, token


async def test_old_cookie_reads_owner_logs_and_ignores_origin(app, db, settings):
    admin, _ = await legacy_client(app, db, settings, role="admin", name="ActOldAdmin", cookie="fire_session")
    user, user_token = await legacy_client(
        app, db, settings, role="user", name="ActOldUser", cookie="stocklog_session"
    )
    try:
        listed = await admin.get("/api/activities")
        assert listed.status_code == 200, listed.text
        body = listed.json()
        assert any(row["detail"] == "ActOldUser-only" for row in body["systemLogs"])
        assert any(row["detail"] == "ActOldAdmin-only" for row in body["systemLogs"])
        assert all(row["detail"] != "ActOldUser-only" for row in body["userLogs"])
        assert all(set(row) == FIELDS and row["ip"] == "" for row in body["systemLogs"] + body["userLogs"])

        personal = await user.get("/api/activities")
        assert personal.status_code == 200, personal.text
        own = personal.json()
        assert own["systemLogs"] == []
        assert any(row["detail"] == "ActOldUser-only" for row in own["userLogs"])
        assert all(row["detail"] != "ActOldAdmin-only" for row in own["userLogs"])

        fat = "fat_" + "a" * 43
        blocked = await admin.get("/api/activities", headers={"authorization": "Bearer " + fat})
        assert blocked.status_code == 401 and blocked.json() == {"error": "未登录"}
        assert blocked.text == '{"error":"未登录"}'
        assert blocked.headers.get("x-alcor-retire-context") is None

        evil = await admin.get("/api/activities", headers={"origin": "http://evil.example"})
        assert evil.status_code == 200, evil.text
        assert any(row["detail"] == "ActOldAdmin-only" for row in evil.json()["systemLogs"])

        crossed = await admin.get("/api/activities", headers={"authorization": "Bearer " + user_token})
        assert crossed.status_code == 200, crossed.text
        assert crossed.json()["systemLogs"] == []
        assert any(row["detail"] == "ActOldUser-only" for row in crossed.json()["userLogs"])
        assert all(row["detail"] != "ActOldAdmin-only" for row in crossed.json()["userLogs"])
    finally:
        await admin.aclose()
        await user.aclose()


async def test_alcor_session_keeps_origin_rejection_beside_old_cookie(client, admin, db):
    assert admin
    token = b"act-alcor-old".hex().ljust(64, "b")[:64]
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at)
               SELECT %s,%s,'legacy-web',session_version,clock_timestamp()+interval '1 day'
               FROM users WHERE id=%s""",
            (digest(token), admin, admin),
        )
    client.cookies.set("fire_session", token)
    denied = await client.get("/api/activities", headers={"origin": "http://evil.example"})
    assert denied.status_code == 403
    assert denied.headers.get("x-alcor-retire-context") == "true"
