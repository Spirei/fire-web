"""Old api-docs keeps the numeric envelope. An Alcor session keeps the native receipt."""

import hashlib

import httpx
import pytest_asyncio
from alcor_api.api_documents import _BODY_LIMIT, js_declared_exceeds
from alcor_api.cli import create_user
from alcor_api.security import digest

SUCCESS = {"code", "message", "data"}


def open_client(app, **headers):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver", "accept": "*/*", **headers},
    )


@pytest_asyncio.fixture
async def legacy_admin(app, db, settings):
    user_id = await create_user(settings, "DocsAdmin", "Synthetic9Pass", role="admin")
    token = b"docs-admin".hex().ljust(64, "a")[:64]
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at)
               SELECT %s,%s,'legacy-web',session_version,clock_timestamp()+interval '1 day'
               FROM users WHERE id=%s""",
            (digest(token), user_id, user_id),
        )
    client = open_client(app)
    client.cookies.set("fire_session", token)
    try:
        yield client, user_id, token
    finally:
        await client.aclose()


def test_declared_length_uses_the_reviewed_numeric_comparison():
    assert js_declared_exceeds(None, _BODY_LIMIT) is False
    assert js_declared_exceeds("abc", _BODY_LIMIT) is False
    assert js_declared_exceeds(str(_BODY_LIMIT), _BODY_LIMIT) is False
    assert js_declared_exceeds(str(_BODY_LIMIT + 1), _BODY_LIMIT) is True
    assert js_declared_exceeds("0x1", 0) is True


async def test_old_cookie_reads_and_saves_without_a_request_id(app, db, settings, legacy_admin):
    client, user_id, _ = legacy_admin
    missing = await client.get("/api/api-docs?path=secret")
    assert missing.status_code == 500
    assert missing.json() == {"code": 50001, "message": "读取文档失败"}
    assert (await client.get("/api/api-docs?version=3")).json()["message"] == "不支持的文档版本"
    assert (await client.get("/api/api-docs?version=1&version=2")).status_code == 400
    anonymous = open_client(app)
    try:
        logged_out = await anonymous.post("/api/api-docs", json={"content": "x", "requestId": "ignored"})
        assert logged_out.status_code == 401 and logged_out.json() == {"code": 40101, "message": "未登录"}
        modern = open_client(app, accept="application/json")
        assert (await modern.get("/api/api-docs")).status_code == 503
        assert isinstance((await modern.post("/api/api-docs", json={"content": "x"})).json()["error"], dict)
        await modern.aclose()
    finally:
        await anonymous.aclose()

    user = open_client(app)
    user_token = b"docs-user".hex().ljust(64, "b")[:64]
    user_id_2 = await create_user(settings, "DocsUser", "Synthetic9Pass", role="user")
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at)
               SELECT %s,%s,'legacy-web',session_version,clock_timestamp()+interval '1 day'
               FROM users WHERE id=%s""",
            (digest(user_token), user_id_2, user_id_2),
        )
    user.cookies.set("stocklog_session", user_token)
    denied = await user.post("/api/api-docs", json={"content": "x"})
    assert denied.status_code == 403 and denied.json() == {"code": 40301, "message": "需要管理员权限"}
    await user.aclose()

    fat = "fat_" + "a" * 43
    blocked = await client.post(
        "/api/api-docs", headers={"authorization": "Bearer " + fat}, json={"content": "x"}
    )
    assert blocked.status_code == 401 and blocked.json()["message"] == "未登录"
    untrusted = await client.post(
        "/api/api-docs", headers={"origin": "http://evil.example"}, json={"content": "x"}
    )
    assert untrusted.status_code == 401 and untrusted.json()["message"] == "未登录"

    created = await client.post("/api/api-docs?version=v2&path=secret", json={"content": "中文"})
    assert created.status_code == 200, created.text
    assert set(created.json()) == SUCCESS
    data = created.json()["data"]
    assert set(data) == {"saved", "version", "bytes", "revision"}
    assert data["saved"] is True and data["version"] == 2 and data["bytes"] == len("中文".encode())
    assert data["revision"] == hashlib.sha256("中文".encode()).hexdigest()
    public = await anonymous_get(app)
    assert public["content"] == "中文" and public["path"] == "docs/api-spec-v2.md" and public["version"] == 2
    replaced = await client.post("/api/api-docs?version=2", json={"content": "next"})
    assert replaced.status_code == 200 and replaced.json()["data"]["bytes"] == 4
    stale = "0" * 64
    conflict = await client.post(
        "/api/api-docs?version=2", json={"content": "nope", "expectedRevision": stale}
    )
    assert conflict.status_code == 409
    assert conflict.json() == {"code": 40901, "message": "文档已被更新，请重新读取后再保存"}
    matched = await client.post(
        "/api/api-docs?version=2",
        json={"content": "kept", "expectedRevision": replaced.json()["data"]["revision"]},
    )
    assert (
        matched.status_code == 200
        and matched.json()["data"]["revision"] == hashlib.sha256(b"kept").hexdigest()
    )
    absent = await client.post(
        "/api/api-docs?version=1", json={"content": "new", "expectedRevision": "ab" * 32}
    )
    assert absent.status_code == 500 and absent.json() == {"code": 50001, "message": "保存文档失败"}
    invalid = await client.post("/api/api-docs", json={"content": "x", "requestId": "nope"})
    assert invalid.status_code == 400 and invalid.json()["message"] == "文档参数无效"
    assert (
        await client.post("/api/api-docs", json={"content": "x", "expectedRevision": None})
    ).status_code == 400
    huge = await client.post("/api/api-docs", json={"content": "x" * (512 * 1024 + 1)})
    assert huge.status_code == 400 and huge.json()["message"] == "文档内容过大"
    over = await client.post("/api/api-docs", content=b'{"content":"y"}' + b" " * _BODY_LIMIT)
    assert over.status_code == 400 and over.json()["message"] == "文档参数无效"
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT content FROM api_documents WHERE version=1")).fetchone()
        ) is None
        assert (await (await conn.execute("SELECT content FROM api_documents WHERE version=2")).fetchone())[
            "content"
        ] == "kept"
        assert (await (await conn.execute("SELECT count(*) AS n FROM api_document_operations")).fetchone())[
            "n"
        ] == 0
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action='api.document.saved' AND actor_id=%s",
                    (user_id,),
                )
            ).fetchone()
        )["n"] == 3


async def anonymous_get(app):
    client = open_client(app)
    try:
        response = await client.get("/api/api-docs?version=2")
        assert response.status_code == 200 and set(response.json()) == SUCCESS
        return response.json()["data"]
    finally:
        await client.aclose()


async def test_old_save_rechecks_the_session_and_alcor_keeps_its_receipt(
    app, db, client, admin, legacy_admin, monkeypatch
):
    assert admin
    old, docs_user, _ = legacy_admin
    import alcor_api.api_documents as docs

    original = docs.legacy_docs_user
    state = {"n": 0}

    async def drop_role(request):
        who = await original(request)
        state["n"] += 1
        if state["n"] == 1 and who is not None:
            async with db.connection() as conn, conn.transaction():
                await conn.execute("UPDATE users SET role='user' WHERE id=%s", (who.id,))
        return who

    monkeypatch.setattr(docs, "legacy_docs_user", drop_role)
    changed = await old.post("/api/api-docs", json={"content": "role"})
    assert changed.status_code == 403 and changed.json()["message"] == "需要管理员权限"
    monkeypatch.setattr(docs, "legacy_docs_user", original)
    async with db.connection() as conn, conn.transaction():
        await conn.execute("UPDATE users SET role='admin' WHERE id=%s", (docs_user,))

    state["n"] = 0

    async def drop_session(request):
        who = await original(request)
        state["n"] += 1
        if state["n"] == 1 and who is not None:
            async with db.connection() as conn, conn.transaction():
                await conn.execute(
                    "DELETE FROM sessions WHERE user_id=%s AND client_id='legacy-web'", (who.id,)
                )
        return who

    monkeypatch.setattr(docs, "legacy_docs_user", drop_session)
    lost = await old.post("/api/api-docs", json={"content": "gone"})
    assert lost.status_code == 401 and lost.json() == {"code": 40101, "message": "登录已失效"}

    assert (await client.get("/api/api-docs")).status_code == 503
    assert (await client.get("/api/api-docs?path=secret")).status_code == 400
    native = await client.post(
        "/api/api-docs",
        json={
            "content": "native",
            "expectedRevision": None,
            "requestId": "00000000-0000-4000-8000-000000000001",
        },
    )
    assert native.status_code == 200, native.text
    assert native.json()["data"]["requestId"] == "00000000-0000-4000-8000-000000000001"
    old.cookies.set("alcor_session", client.cookies["alcor_session"])
    old.headers["x-csrf-token"] = client.headers["x-csrf-token"]
    kept = await old.get("/api/api-docs?path=secret")
    assert kept.status_code == 400
    rejected = await old.post("/api/api-docs", json={"content": "old-shape"})
    assert rejected.status_code == 422
