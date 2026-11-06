import httpx
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes as all_tables_and_hashes
from alcor_api.cli import create_user


async def tables_and_hashes(conn):
    observed = await all_tables_and_hashes(conn)
    # The independent request recorder may flush while pure activity reads run.
    telemetry = REQUEST_TELEMETRY_TABLES
    return {name: row for name, row in observed.items() if name not in telemetry}


async def test_activity_owner_admin_legacy_cookie_and_pure_reads(client, admin, app, settings, db):
    user = await create_user(settings, "ActivityUser", "SyntheticActivity9", role="user")
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'synthetic.owner','owned-target'),(%s,'synthetic.admin','admin-target')",
            (user, admin),
        )
        before = await tables_and_hashes(conn)
    global_read = await client.get("/api/activities")
    assert global_read.status_code == 200, global_read.text
    assert any(r["event"] == "synthetic.admin" for r in global_read.json()["userLogs"])
    assert any(r["event"] == "synthetic.owner" for r in global_read.json()["systemLogs"])
    async with db.connection() as conn, conn.transaction():
        assert await tables_and_hashes(conn) == before
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Origin": "http://testserver"},
    ) as other:
        response = await other.post(
            "/api/auth/login", json={"username": "ActivityUser", "password": "SyntheticActivity9"}
        )
        assert response.status_code == 200, response.text
        async with db.connection() as conn, conn.transaction():
            before = await tables_and_hashes(conn)
        result = await other.get("/api/activities")
        assert result.status_code == 200, result.text
        body = result.json()
        assert body["systemLogs"] == []
        assert any(r["event"] == "synthetic.owner" for r in body["userLogs"])
        assert all(r["event"] != "synthetic.admin" for r in body["userLogs"])
        assert all(
            set(r) == {"id", "event", "detail", "ip", "createdAt", "userName"} for r in body["userLogs"]
        )
        async with db.connection() as conn, conn.transaction():
            assert await tables_and_hashes(conn) == before
        denied = await other.get("/api/activities", headers={"Authorization": "Bearer invalid"})
        assert denied.status_code == 401 and denied.json() == {"error": "未登录"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        assert (await anonymous.get("/api/activities")).status_code == 401


async def test_activity_uses_current_display_name_and_fixed_newest_200(client, admin, db):
    from uuid import uuid4

    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO user_profiles(user_id,display_name,revision) VALUES(%s,'Synthetic display name',%s) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name",
            (admin, uuid4()),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action) SELECT %s,'synthetic.order.'||n FROM generate_series(0,204) n",
            (admin,),
        )
    result = await client.get("/api/activities")
    assert result.status_code == 200, result.text
    for key in ("userLogs", "systemLogs"):
        rows = result.json()[key]
        assert len(rows) == 200
        assert [r["event"] for r in rows] == [f"synthetic.order.{i}" for i in range(204, 4, -1)]
        assert all(r["userName"] == "Synthetic display name" for r in rows)
