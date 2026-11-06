"""Fresh verified PG only; owner-only projections do not mutate business state."""

from uuid import uuid4

import httpx
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.native_app_auth import issue_grant
from alcor_api.operation_history_api import mount_operation_history
from psycopg.types.json import Jsonb
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES

PATH = "/api/account/operation-history"
PRIVATE = "SYNTHETIC_PRIVATE_VALUE_NOT_FOR_HISTORY"


async def business_hashes(db):
    async with db.connection() as conn, conn.transaction():
        return {name: value for name, value in (await tables_and_hashes(conn)).items()
                if name not in REQUEST_TELEMETRY_TABLES}


def mounted(app, db):
    if not any(getattr(route, "path", None) == PATH for route in app.routes):
        mount_operation_history(app, db)


async def seed_import(conn, owner, instance, *, preview=False, state="completed", executed=True):
    rid, source = uuid4(), uuid4()
    if preview:
        await conn.execute("""INSERT INTO personal_data_transfer_sources
            (owner_id,id,request_id,origin_instance,sha256,raw) VALUES(%s,%s,%s,%s,%s,%s)""",
            (owner, source, rid, instance, "1" * 64, PRIVATE.encode()))
        await conn.execute("""INSERT INTO personal_data_transfer_previews
            (owner_id,id,source_id,request_id,request_hash,authorization_binding,plan)
            VALUES(%s,%s,%s,%s,%s,%s,%s)""", (owner, uuid4(), source, rid, "hash", "binding",
                Jsonb({"counts": {"records": 0, "watchGroups": 2, "access_token": 999}, "payload": PRIVATE})))
    if not preview or state != "previewed":
        await conn.execute("""INSERT INTO personal_data_transfer_operations
            (owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)""", (owner, rid, "hash",
                Jsonb({"state": state, "executed": executed, "counts": {"records": 0, "watchGroups": 2},
                       "payload": PRIVATE, "password": PRIVATE})))
    return str(rid)


async def seed_task(conn, owner, *, kind="backup.create", status="failed", error="backup_failed"):
    tid, rid = uuid4(), uuid4()
    await conn.execute("""INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,error_code,result,payload)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (tid, owner, rid, "fingerprint", kind, status, error,
            Jsonb({"backup_id": str(uuid4()), "bytes": 2048, "files_verified": 0,
                   "message": PRIVATE, "password": PRIVATE}), Jsonb({"restore_ticket": PRIVATE})))
    return str(tid)


async def test_owned_projections_pagination_and_pure_business_reads(client, admin, db, app, settings):
    mounted(app, db)
    other = await create_user(settings, "HistoryOther", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        completed = await seed_import(conn, admin, settings.instance_id, preview=True)
        preview = await seed_import(conn, admin, settings.instance_id, preview=True, state="previewed")
        closed = await seed_import(conn, admin, settings.instance_id, state="closed", executed=False)
        other_import = await seed_import(conn, other, settings.instance_id)
        for owner, category in ((admin, "watch"), (admin, "fees"), (other, "watch")):
            table = "watch_display_operations" if category == "watch" else "fee_state_operations"
            # Only fixed internal table names; owner and receipt values remain bound parameters.
            await conn.execute(f"INSERT INTO {table}(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (owner, uuid4(), "f" * 64, Jsonb({"state": "completed", "data": {"fields": PRIVATE}})))
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic history device")
        native_id = pair["grant_id"]
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (other,))).fetchone()
        other_pair = await issue_grant(conn, user, "portfolio.read", "Other owner's device")
        await conn.execute("""INSERT INTO registered_clients(client_id,name,redirect_uris,scopes,revision,updated_by)
            VALUES('history-client','Synthetic client',%s,%s,%s,%s)""",
            (Jsonb(["https://client.example.invalid/callback"]), ["profile.read"], uuid4(), admin))
        await conn.execute("""INSERT INTO client_grants
            (id,owner_id,client_id,client_revision,session_version,device_name,scopes,expires_at)
            SELECT %s,%s,client_id,revision,1,'Synthetic PKCE device',ARRAY['profile.read'],
                   clock_timestamp()+interval '1 day' FROM registered_clients WHERE client_id='history-client'""",
            (uuid4(), admin))
        task = await seed_task(conn, admin)
        await seed_task(conn, admin, kind="backup.retention", error="backup_retention_unknown")
        other_task = await seed_task(conn, other)
        diagnostic = await seed_task(conn, admin, kind="system.diagnostics")
    before = await business_hashes(db)
    all_items = {}
    for kind in ("import", "api", "sync", "backup"):
        response = await client.get(PATH, params={"kind": kind, "limit": 50})
        assert response.status_code == 200, response.text
        assert "no-store" in response.headers["cache-control"].split(", ")
        assert PRIVATE not in response.text
        assert other_import not in response.text and other_task not in response.text
        assert other_pair["grant_id"] not in response.text and diagnostic not in response.text
        assert "restore_ticket" not in response.text and "security_stamp" not in response.text
        all_items[kind] = response.json()["items"]
    imports = {row["requestId"]: row for row in all_items["import"]}
    assert len(imports) == 3
    assert imports[completed]["status"] == "success"
    assert imports[preview]["status"] == "confirm" and "尚未导入" in imports[preview]["message"]
    assert imports[closed]["statusLabel"] == "已关闭未导入"
    assert {"label": "记录", "value": "0"} in imports[completed]["fields"]
    first = await client.get(PATH, params={"kind": "import", "limit": 2})
    second = await client.get(PATH, params={"kind": "import", "limit": 2, "offset": 2})
    assert first.json()["hasMore"] is True and second.json()["hasMore"] is False
    assert {row["id"] for row in first.json()["items"]}.isdisjoint(row["id"] for row in second.json()["items"])
    assert len(all_items["api"]) == 2
    assert any(native_id in row["id"] for row in all_items["api"])
    assert all(row["statusLabel"] == "授权已记录" for row in all_items["api"])
    assert all("在线" in row["message"] for row in all_items["api"])
    assert all(row["status"] == "unknown" and row["statusLabel"] == "变更已记录" for row in all_items["sync"])
    assert all("对端" in row["message"] for row in all_items["sync"])
    assert all_items["sync"][0]["createdAt"] is not None
    assert all_items["sync"][1]["createdAt"] is None
    backups = all_items["backup"]
    failed = next(row for row in backups if task in row["id"])
    assert "备份工具" in failed["message"]
    assert {"label": "已校验文件数", "value": "0"} in failed["fields"]
    assert any(row["status"] == "unknown" and row["statusLabel"] == "保留结果待核对" for row in backups)
    assert await business_hashes(db) == before


async def test_authentication_roles_boundaries_and_invalid_queries(client, admin, db, app, settings):
    mounted(app, db)
    for query in ("kind=invalid", "kind=import&limit=0", "kind=import&limit=51", "kind=import&offset=-1",
                  "kind=import&offset=100001"):
        assert (await client.get(PATH + "?" + query)).status_code == 422
    for query in ("kind=import&kind=api", "kind=import&limit=1&limit=2", "kind=import&owner=other"):
        assert (await client.get(PATH + "?" + query)).status_code == 400
    bad_binding = await client.get(PATH + "?kind=import", headers={"x-csrf-token": "wrong"})
    assert bad_binding.status_code == 403
    assert bad_binding.headers["x-alcor-session-changed"] == "true"
    assert bad_binding.headers["x-alcor-retire-context"] == "true"
    client.cookies.set("fire_session", "")
    assert (await client.get(PATH + "?kind=api")).status_code == 200
    assert (await client.get(PATH + "?kind=api", headers={"authorization": "Bearer synthetic"})).status_code == 403
    assert (await client.get(PATH + "?kind=api", headers={"origin": "https://foreign.example.invalid"})).status_code == 403
    owner = await create_user(settings, "HistoryOrdinary", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver",
                                 headers={"origin": "http://testserver"}) as ordinary:
        assert (await ordinary.get(PATH + "?kind=import")).status_code == 401
        signed = await ordinary.post("/api/session/login", json={"login": "HistoryOrdinary", "password": "Synthetic9Pass"})
        assert signed.status_code == 200, signed.text
        ordinary.headers["x-csrf-token"] = signed.json()["csrf"]
        assert (await ordinary.get(PATH + "?kind=backup")).status_code == 403
        assert (await ordinary.get(PATH + "?kind=import")).json()["items"] == []
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET active=false WHERE id=%s", (owner,))
        retired = await ordinary.get(PATH + "?kind=import")
        assert retired.status_code == 401 and retired.headers["x-alcor-retire-context"] == "true"
