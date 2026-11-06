import asyncio
import hashlib
from uuid import uuid4

import httpx


async def test_fixed_versions_public_missing_cas_and_original_receipt(client, admin, app, db):
    assert (await client.get("/api/api-docs")).status_code == 503
    for query in ("?version=3", "?version=../secret", "?version=1&version=2", "?path=secret"):
        assert (await client.get("/api/api-docs" + query)).status_code == 400
    missing = await client.get("/api/system/api-docs?version=v2")
    assert missing.status_code == 200
    assert missing.json()["revision"] is None
    body = {
        "requestId": str(uuid4()),
        "expectedRevision": None,
        "content": "# Synthetic reference\n\n中文 *source*",
    }
    response = await client.post("/api/api-docs?version=v2", json=body)
    assert response.status_code == 200, response.text
    value = response.json()["data"]
    assert value["revision"] == hashlib.sha256(body["content"].encode()).hexdigest()
    assert value["bytes"] == len(body["content"].encode())
    assert (await client.post("/api/api-docs?version=2", json=body)).json()["data"] == value
    assert (
        await client.post("/api/api-docs?version=2", json={**body, "content": "different"})
    ).status_code == 409
    rid = str(uuid4())
    conflict = {**body, "requestId": rid, "content": "conflict"}
    assert (await client.post("/api/api-docs?version=2", json=conflict)).status_code == 409
    assert (await client.get("/api/system/api-docs/operations/" + rid)).json()["state"] == "failed"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Origin": "http://testserver"},
    ) as anonymous:
        public = (await anonymous.get("/api/api-docs?version=2")).json()["data"]
        assert public["content"] == body["content"]
        assert public["path"] == "docs/api-spec-v2.md"
        assert (await anonymous.post("/api/api-docs?version=2", json=body)).status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM api_documents")).fetchone())["n"] == 1
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='api.document.saved'")
            ).fetchone()
        )["n"] == 1


async def test_documents_parallel_cas_close_and_atomic_failure(client, admin, db, app, monkeypatch):
    # Same empty head, distinct UUIDs: exactly one commit and one persistent conflict.
    bodies = [{"requestId": str(uuid4()), "expectedRevision": None, "content": str(i)} for i in range(2)]
    replies = await asyncio.gather(*(client.post("/api/api-docs", json=b) for b in bodies))
    assert sorted(r.status_code for r in replies) == [200, 409]
    rid = str(uuid4())
    closed = await client.post("/api/system/api-docs/operations/" + rid + "/close", json={})
    assert closed.status_code == 200
    assert closed.json()["state"] == "closed"
    current = (await client.get("/api/system/api-docs")).json()
    assert (
        await client.post(
            "/api/api-docs",
            json={"requestId": rid, "expectedRevision": current["revision"], "content": "late"},
        )
    ).status_code == 409
    # Database failure after document UPDATE rolls back document, audit and operation together.
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION fail_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='api.document.saved' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER fail_document_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_document_audit()"
        )
    bad = {"requestId": str(uuid4()), "expectedRevision": current["revision"], "content": "rollback"}
    assert (await client.post("/api/api-docs", json=bad)).status_code == 503
    assert (await client.get("/api/system/api-docs")).json() == current
    assert (await client.get("/api/system/api-docs/operations/" + bad["requestId"])).status_code == 404


async def test_document_limits_and_current_role(client, admin, settings, app, db):
    payload = {"requestId": str(uuid4()), "expectedRevision": None, "content": "中" * (524288 // 3 + 1)}
    assert (await client.post("/api/api-docs", json=payload)).status_code == 422
    payload["content"] = "x" * 524288
    assert (await client.post("/api/api-docs", json=payload)).status_code == 200
    payload["requestId"] = str(uuid4())
    payload["content"] = "\ud800"
    import json

    assert (
        await client.post(
            "/api/api-docs", content=json.dumps(payload), headers={"Content-Type": "application/json"}
        )
    ).status_code == 422
    assert (
        await client.get("/api/system/api-docs", headers={"Authorization": "Bearer secret"})
    ).status_code == 403
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    assert (await client.get("/api/system/api-docs")).status_code == 403
    assert (
        await client.post(
            "/api/api-docs", json={"requestId": str(uuid4()), "expectedRevision": None, "content": "x"}
        )
    ).status_code == 403


async def test_postcommit_http_loss_recovers_original_uuid_through_actual_web_parser(
    client, admin, app, db, monkeypatch
):
    import asyncio
    import json
    import subprocess
    from pathlib import Path

    original = app.state.api_documents.save

    async def lose_response(*args, **kwargs):
        await original(*args, **kwargs)
        raise ConnectionError("synthetic result lost after commit")

    monkeypatch.setattr(app.state.api_documents, "save", lose_response)
    rid = str(uuid4())
    body = {"requestId": rid, "expectedRevision": None, "content": "# Synthetic post-commit reference"}
    result = await client.post("/api/api-docs", json=body)
    assert result.status_code == 503
    receipt = await client.get("/api/system/api-docs/operations/" + rid)
    assert receipt.status_code == 200
    parser = Path(__file__).resolve().parents[2] / "tests/fixtures/former-web-protocol/api-reference-state.ts"
    script = (
        "import {referenceReceipt} from "
        + json.dumps(parser.as_uri())
        + "; import fs from 'node:fs';const value=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(referenceReceipt(value.receipt,value.id)));"
    )
    checked = await asyncio.to_thread(
        subprocess.run,
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        input=json.dumps({"id": rid, "receipt": receipt.json()}),
        text=True,
        capture_output=True,
        check=True,
    )
    assert json.loads(checked.stdout) == receipt.json()
    assert receipt.json()["state"] == "completed"
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='api.document.saved'")
            ).fetchone()
        )["n"] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM api_document_operations")).fetchone())[
            "n"
        ] == 1
