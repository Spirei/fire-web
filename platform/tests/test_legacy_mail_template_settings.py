"""Actual captured old route goldens plus isolated PG authority/race checks."""

import asyncio
import hashlib
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
from alcor_api.mail_template_model import DEFAULTS
from frozen_legacy import source_root


async def login(client):
    result = await client.post(
        "/api/auth/register", json={"username": "MailSettingsAdmin", "password": "SyntheticMailPass9"}
    )
    assert result.status_code == 201
    return result.json()["user"]["id"]


async def test_captured_source_golden_settings_defaults_validation_and_save(client):
    fixture = Path(__file__).parent / "fixtures/mail-settings-source"
    manifest = json.loads((fixture / "source.json").read_text())
    assert hashlib.sha256((fixture / "route.ts").read_bytes()).hexdigest() == manifest["sha256"]
    root = source_root("ALCOR_MAIL_LEGACY_ROOT", ["lib/mailTemplateModel.ts"])
    runner = Path(__file__).parent / "mail_templates_candidate/settings_routes.cjs"
    result = await asyncio.to_thread(
        subprocess.run,
        ["node", "--experimental-vm-modules", str(runner), str(root), str(fixture / "route.ts")],
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    cases = json.loads(result.stdout)
    for case in cases:
        if case["role"] == "admin" and not client.cookies.get("fire_session"):
            await login(client)
        response = await (
            client.get("/api/settings/mail-templates")
            if case["method"] == "GET"
            else client.put("/api/settings/mail-templates", json=case["input"])
        )
        assert response.status_code == case["status"] and response.json() == case["body"]


async def test_uuid_cas_receipt_no_send_and_bearer_read(client, app, db):
    await login(client)
    token = client.cookies["fire_session"]
    original = await client.get("/api/settings/mail-templates")
    assert original.json() == {"templates": DEFAULTS}
    headers = {"x-alcor-request-id": str(uuid4()), "x-alcor-templates-revision": "0"}
    body = {**DEFAULTS[0], "subject": "合成保存 {{siteName}}"}
    saved = await client.put("/api/settings/mail-templates", json=body, headers=headers)
    assert saved.status_code == 200
    assert saved.headers["x-alcor-request-id"] == headers["x-alcor-request-id"]
    recovered = await client.get("/api/settings/mail-templates/operations/" + headers["x-alcor-request-id"])
    assert recovered.status_code == 200 and recovered.json()["state"] == "completed"
    assert recovered.json()["template"] == body
    assert (
        await client.put("/api/settings/mail-templates", json=body, headers=headers)
    ).json() == saved.json()
    assert (
        await client.put("/api/settings/mail-templates", json={**body, "subject": "changed"}, headers=headers)
    ).status_code == 409
    stale = await client.put(
        "/api/settings/mail-templates", json=body, headers={**headers, "x-alcor-request-id": str(uuid4())}
    )
    assert stale.status_code == 409
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as other:
        response = await other.get(
            "/api/settings/mail-templates", headers={"authorization": "Bearer " + token}
        )
        assert response.json() == saved.json()
        assert (
            await other.get("/api/settings/mail-templates", headers={"authorization": "Bearer invalid"})
        ).status_code == 403
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_mail_outbox")).fetchone())[
            "n"
        ] == 0
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action='mail.template.saved'"
                )
            ).fetchone()
        )["n"] == 1


async def test_origin_stream_budget_and_revocation_after_body(client, app, db, monkeypatch):
    user = await login(client)
    path = "/api/settings/mail-templates"
    assert (await client.put(path, json=DEFAULTS[0], headers={"origin": "https://other.invalid"})).json() == {
        "error": "需要管理员权限"
    }

    async def chunks():
        yield b'"'
        yield b"x" * 16384
        yield b'"'

    oversized = await client.put(path, content=chunks())
    assert oversized.status_code == 400 and oversized.json() == {"error": "request body too large"}
    import alcor_api.legacy_mail_template_settings as module

    original = module.bounded_body

    async def revoke(*args):
        raw = await original(*args)
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET role='user' WHERE id=%s", (user,))
        return raw

    monkeypatch.setattr(module, "bounded_body", revoke)
    result = await client.put(path, json=DEFAULTS[0])
    assert result.status_code == 403 and result.json() == {"error": "登录已失效"}
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM mail_template_operations")).fetchone()
