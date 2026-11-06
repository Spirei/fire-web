import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pytest
import test_registry
from alcor_api.cli import create_user
from alcor_api.operational_source_registry import load_operational_sources
from test_account_admin import login
from source_auth_fixture import enable_totp, payload, proof

enrollment = test_registry.enrollment
WEB = "# Synthetic Web\n\n中文".encode()
APP = b"# Synthetic App\n"
PERMISSIONS = "/api/operational-sources/api-documents/permissions"
CAPTURES = "/api/operational-sources/api-documents/captures"
APPLICATIONS = "/api/operational-sources/api-documents/applications"
CLOSURES = "/api/operational-sources/api-documents/closures"
RECEIPTS = "/api/operational-sources/api-documents/receipts/"


def message(response):
    return response.json()["error"]["message"]


@pytest.fixture
async def documents(settings, enrollment):
    registration, config, original, legacy = enrollment
    root = Path(config["sources"][0]["root"])
    (root / "docs").mkdir(mode=0o700)
    (root / "docs/api-spec.md").write_bytes(WEB)
    (root / "docs/api-spec-v2.md").write_bytes(APP)
    source = load_operational_sources(settings)["synthetic-ops"]
    return source, registration, config, original, legacy, root


def apply_body(capture_id, request_id, secret_code, expected):
    return {
        "captureId": capture_id,
        "requestId": str(request_id),
        "expectedRevision": expected,
        "password": "Synthetic9Pass",
        "code": secret_code,
    }


async def test_archived_file_applies_once_and_replay_keeps_the_first_bytes(
    client, admin, settings, db, documents
):
    source, _, _, _, _, root = documents
    secret = await enable_totp(settings, db, admin)
    granted = await client.post(
        PERMISSIONS, json=payload(source.alias, uuid4(), await proof(secret, db, admin))
    )
    assert granted.status_code == 200, granted.text
    assert granted.json()["historicalVersionsKnown"] is False
    assert granted.json()["captureComplete"] is False
    capture_id = uuid4()
    preview = await client.post(
        CAPTURES,
        json=payload(source.alias, capture_id, await proof(secret, db, admin), version=1),
    )
    assert preview.status_code == 200, preview.text
    page = preview.json()
    assert page["applied"] is False and page["captureComplete"] is True
    assert page["historicalVersionsKnown"] is False
    assert page["contentSha256"] == hashlib.sha256(WEB).hexdigest()
    assert "中文" not in preview.text and "api-spec" not in preview.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM api_documents")).fetchone())["n"] == 0
    (root / "docs/api-spec.md").write_bytes(b"# Changed\n")
    replay = await client.post(
        CAPTURES,
        json=payload(source.alias, capture_id, "000000", version=1),
    )
    assert replay.status_code == 200 and replay.json() == page
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT count(*) AS n FROM operational_document_captures")).fetchone()
        )["n"] == 1
    applied = await client.post(
        APPLICATIONS,
        json=apply_body(page["captureId"], uuid4(), await proof(secret, db, admin), None),
    )
    assert applied.status_code == 200, applied.text
    receipt = applied.json()
    assert receipt["state"] == "applied" and receipt["saved"] is True
    assert receipt["captureComplete"] is True and receipt["historicalVersionsKnown"] is False
    assert receipt["revision"] == hashlib.sha256(WEB).hexdigest()
    assert receipt["progressRevision"] == 1
    again = await client.post(
        APPLICATIONS,
        json=apply_body(page["captureId"], receipt["requestId"], "000000", None),
    )
    assert again.status_code == 200 and again.json() == receipt
    assert (await client.get(RECEIPTS + receipt["requestId"])).json() == receipt
    public = await client.get("/api/api-docs?version=1")
    assert public.status_code == 200, public.text
    assert public.json()["data"]["content"] == WEB.decode()
    assert public.json()["data"]["revision"] == receipt["revision"]
    duplicate = await client.post(
        APPLICATIONS,
        json=apply_body(page["captureId"], uuid4(), await proof(secret, db, admin), receipt["revision"]),
    )
    assert duplicate.status_code == 409
    assert message(duplicate) == "该捕获已经应用"
    refreshed = await client.post(
        CAPTURES,
        json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1),
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["contentSha256"] == hashlib.sha256(b"# Changed\n").hexdigest()
    updated = await client.post(
        APPLICATIONS,
        json=apply_body(
            refreshed.json()["captureId"], uuid4(), await proof(secret, db, admin), receipt["revision"]
        ),
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["historicalVersionsKnown"] is False
    assert updated.json()["progressRevision"] == 2
    current = (await client.get("/api/api-docs?version=1")).json()["data"]
    assert current["content"] == "# Changed\n"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM api_documents")).fetchone())["n"] == 1
        saved = await (
            await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='api.document.saved'")
        ).fetchone()
        assert saved["n"] == 2
    second = await client.post(
        CAPTURES,
        json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=2),
    )
    assert second.status_code == 200, second.text
    other = await client.post(
        APPLICATIONS,
        json=apply_body(second.json()["captureId"], uuid4(), await proof(secret, db, admin), None),
    )
    assert other.status_code == 200, other.text
    assert other.json()["historicalVersionsKnown"] is False
    assert (await client.get("/api/api-docs?version=1")).json()["data"]["content"] == "# Changed\n"
    assert (await client.get("/api/api-docs?version=2")).json()["data"]["content"] == APP.decode()


async def test_stale_revision_and_closed_source_do_not_invent_history(client, admin, settings, db, documents):
    source, _, _, original, legacy, _root = documents
    secret = await enable_totp(settings, db, admin)
    native = {"requestId": str(uuid4()), "expectedRevision": None, "content": "# Native head\n"}
    saved = await client.post("/api/api-docs?version=1", json=native)
    assert saved.status_code == 200, saved.text
    head = saved.json()["data"]["revision"]
    spec = source.root / "docs/api-spec.md"
    archived = b"# Archived source\n"
    spec.write_bytes(archived)
    granted = await client.post(
        PERMISSIONS, json=payload(source.alias, uuid4(), await proof(secret, db, admin))
    )
    assert granted.status_code == 200, granted.text
    preview = await client.post(
        CAPTURES, json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1)
    )
    assert preview.status_code == 200, preview.text
    request_id = uuid4()
    rejected = await client.post(
        APPLICATIONS,
        json=apply_body(preview.json()["captureId"], request_id, await proof(secret, db, admin), None),
    )
    assert rejected.status_code == 409
    assert message(rejected) == "文档已变化，请重新读取"
    assert str(source.root) not in rejected.text
    replay = await client.post(
        APPLICATIONS,
        json=apply_body(preview.json()["captureId"], request_id, "000000", None),
    )
    assert replay.status_code == 409 and message(replay) == "文档已变化，请重新读取"
    stored = (await client.get(RECEIPTS + str(request_id))).json()
    assert stored["state"] == "failed" and stored["applied"] is False
    assert stored["historicalVersionsKnown"] is False and stored["captureComplete"] is True
    assert "Archived" not in json.dumps(stored)
    system = await client.get("/api/system/api-docs/operations/" + str(request_id))
    assert system.status_code == 200 and system.json()["state"] == "failed"
    assert (await client.get("/api/api-docs?version=1")).json()["data"]["content"] == native["content"]
    applied = await client.post(
        APPLICATIONS,
        json=apply_body(preview.json()["captureId"], uuid4(), await proof(secret, db, admin), head),
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["revision"] == hashlib.sha256(archived).hexdigest()
    assert applied.json()["historicalVersionsKnown"] is False
    later = b"# Later source\n"
    spec.write_bytes(later)
    later_capture = await client.post(
        CAPTURES, json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1)
    )
    assert later_capture.status_code == 200, later_capture.text
    spec.unlink()
    legacy["sources"][0]["migrationWindow"]["state"] = "revoked"
    original.write_text(json.dumps(legacy))
    moved = await client.post(
        APPLICATIONS,
        json=apply_body(
            later_capture.json()["captureId"],
            uuid4(),
            await proof(secret, db, admin),
            applied.json()["revision"],
        ),
    )
    assert moved.status_code == 200, moved.text
    assert (await client.get("/api/api-docs?version=1")).json()["data"]["content"] == later.decode()
    assert moved.json()["historicalVersionsKnown"] is False
    legacy["sources"][0]["migrationWindow"]["state"] = "active"
    original.write_text(json.dumps(legacy))
    spec.write_bytes(b"# After revoke\n")
    pending = await client.post(
        CAPTURES, json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1)
    )
    assert pending.status_code == 200, pending.text
    revoked = await client.post(
        "/api/operational-sources/api-documents/revocations",
        json=payload(source.alias, uuid4(), await proof(secret, db, admin)),
    )
    assert revoked.status_code == 200, revoked.text
    blocked = await client.post(
        APPLICATIONS,
        json=apply_body(
            pending.json()["captureId"], uuid4(), await proof(secret, db, admin), moved.json()["revision"]
        ),
    )
    assert blocked.status_code == 409
    assert message(blocked) == "来源授权已变化，请重新捕获"
    assert (await client.get("/api/api-docs?version=1")).json()["data"]["content"] == later.decode()
    regranted = await client.post(
        PERMISSIONS, json=payload(source.alias, uuid4(), await proof(secret, db, admin))
    )
    assert regranted.status_code == 200, regranted.text
    stale = await client.post(
        APPLICATIONS,
        json=apply_body(
            pending.json()["captureId"], uuid4(), await proof(secret, db, admin), moved.json()["revision"]
        ),
    )
    assert stale.status_code == 409 and message(stale) == "来源授权已变化，请重新捕获"
    fresh = await client.post(
        CAPTURES, json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1)
    )
    assert fresh.status_code == 200, fresh.text
    async with db.connection() as conn:
        await conn.execute(
            """CREATE FUNCTION fail_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN IF NEW.action='api.document.saved' THEN RAISE EXCEPTION 'synthetic rollback'; END IF;
               RETURN NEW; END $$"""
        )
        await conn.execute(
            """CREATE TRIGGER fail_document_audit BEFORE INSERT ON audit_events
               FOR EACH ROW EXECUTE FUNCTION fail_document_audit()"""
        )
    lost_id = uuid4()
    lost = await client.post(
        APPLICATIONS,
        json=apply_body(
            fresh.json()["captureId"], lost_id, await proof(secret, db, admin), moved.json()["revision"]
        ),
    )
    assert lost.status_code == 503
    assert str(source.root) not in lost.text
    assert (await client.get("/api/api-docs?version=1")).json()["data"]["content"] == later.decode()
    assert (await client.get(RECEIPTS + str(lost_id))).status_code == 404
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT count(*) AS n FROM operational_document_applications WHERE capture_id=%s",
                (fresh.json()["captureId"],),
            )
        ).fetchone()
        assert row["n"] == 0


async def test_document_grant_requires_its_own_scope_factor_and_actor(
    client, admin, app, settings, db, documents
):
    source, registration, config, _, _, _root = documents
    secret = await enable_totp(settings, db, admin)
    missing = await client.post(PERMISSIONS, json=payload(source.alias, uuid4(), "000000"))
    async with db.connection() as conn:
        await conn.execute("DELETE FROM identity_security WHERE user_id=%s", (admin,))
    no_factor = await client.post(PERMISSIONS, json=payload(source.alias, uuid4(), "000000"))
    assert no_factor.status_code == 409
    assert message(no_factor) == "请先启用二次验证"
    secret = await enable_totp(settings, db, admin)
    config["sources"][0]["scopes"] = ["global-request-history"]
    registration.write_text(json.dumps(config))
    denied = await client.post(
        PERMISSIONS, json=payload(source.alias, uuid4(), await proof(secret, db, admin))
    )
    assert denied.status_code == 403
    assert message(denied) == "该运行来源未授予全局API文档"
    config["sources"][0]["scopes"] = ["global-api-documents", "global-request-history"]
    registration.write_text(json.dumps(config))
    history = await client.post(
        "/api/operational-sources/request-history/permissions",
        json=payload(source.alias, uuid4(), await proof(secret, db, admin)),
    )
    assert history.status_code == 200, history.text
    separated = await client.post(
        CAPTURES, json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1)
    )
    assert separated.status_code == 409
    assert message(separated) == "请先确认全局API文档授权"
    user = await create_user(settings, "PlainUser", "Synthetic9Pass", role="user")
    member = await login(app, "PlainUser")
    try:
        assert (
            await member.post(PERMISSIONS, json=payload(source.alias, uuid4(), "000000"))
        ).status_code == 403
    finally:
        await member.aclose()
    assert user
    granted = await client.post(
        PERMISSIONS, json=payload(source.alias, uuid4(), await proof(secret, db, admin))
    )
    assert granted.status_code == 200, granted.text
    duplicate = await client.post(
        PERMISSIONS, json=payload(source.alias, uuid4(), await proof(secret, db, admin))
    )
    assert duplicate.status_code == 409
    assert message(duplicate) == "全局API文档授权已存在，请查询原回执"
    config["sources"][0]["scopes"] = ["global-api-documents"]
    config["sources"][0]["logIdentity"] = None
    registration.write_text(json.dumps(config))
    rebound = await client.post(
        CAPTURES, json=payload(source.alias, uuid4(), await proof(secret, db, admin), version=1)
    )
    assert rebound.status_code == 409
    assert message(rebound) == "来源绑定已变化，请重新核对"
    assert str(source.root) not in rebound.text and "api-spec" not in rebound.text
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT count(*) AS n FROM operational_document_captures")).fetchone()
        )["n"] == 0
    config["sources"][0]["scopes"] = ["global-api-documents", "global-request-history"]
    config["sources"][0]["logIdentity"] = [source.log_identity[0], source.log_identity[1]]
    registration.write_text(json.dumps(config))
    closed_id = uuid4()
    closed = await client.post(
        CLOSURES,
        json={
            "requestId": str(closed_id),
            "password": "Synthetic9Pass",
            "code": await proof(secret, db, admin),
        },
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["historicalVersionsKnown"] is False
    reused = await client.post(
        CAPTURES, json=payload(source.alias, closed_id, await proof(secret, db, admin), version=1)
    )
    assert reused.status_code == 409
    assert message(reused) == "原API文档来源操作已关闭，请查询原编号"
    peer = await create_user(settings, "PeerAdmin", "Synthetic9Pass", role="admin")
    other = await login(app, "PeerAdmin")
    try:
        assert (await other.get(RECEIPTS + granted.json()["requestId"])).status_code == 404
    finally:
        await other.aclose()
    assert peer
    assert missing.status_code == 403
    unknown = await client.post(
        PERMISSIONS, json=payload("missing-alias", uuid4(), await proof(secret, db, admin))
    )
    assert unknown.status_code == 403
    assert message(unknown) == "该运行来源未明确登记"
