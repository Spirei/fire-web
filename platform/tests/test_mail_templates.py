import asyncio
import copy
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from alcor_api.mail_template_model import DEFAULTS, render_text, validate
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_public_templates_are_one_read_only_pg_projection_and_untrusted_origin_is_denied(client, db):
    async with db.connection() as conn:
        before = {
            table: (await (await conn.execute("SELECT count(*) n FROM " + table)).fetchone())["n"]
            for table in (
                "mail_template_state",
                "mail_template_operations",
                "identity_mail_outbox",
                "audit_events",
            )
        }
    for version in (1, 2):
        response = await client.get(f"/api/v{version}/auth/mail-templates")
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {
            "version": 1,
            "style": "alcor-brand-v1",
            "banner_path": "/api/system-assets/mail-banner",
            "templates": DEFAULTS,
        }
        assert response.headers["x-alcor-api-version"] == str(version)
        assert "no-store" in response.headers["cache-control"]
    assert (await client.get("/api/auth/mail-templates")).json()["templates"] == DEFAULTS
    assert (await client.get("/api/v3/auth/mail-templates")).status_code == 404
    assert (
        await client.get("/api/v1/auth/mail-templates", headers={"origin": "https://untrusted.invalid"})
    ).status_code == 403
    async with db.connection() as conn:
        after = {
            table: (await (await conn.execute("SELECT count(*) n FROM " + table)).fetchone())["n"]
            for table in before
        }
    assert before == after
    for authorization in ("Bearer invalid", "Bearer fat_" + "A" * 43, ""):
        denied = await client.get("/api/v2/auth/mail-templates", headers={"authorization": authorization})
        assert denied.status_code == 401
    assert (
        await client.get(
            "/api/v1/auth/mail-templates", headers={"authorization": "Bearer ignored-by-v1-public-contract"}
        )
    ).status_code == 200


@pytest.mark.asyncio
async def test_admin_save_is_cas_idempotent_and_public_read_uses_exact_saved_template(client, admin, db):
    head = await client.get("/api/system/mail-templates")
    assert head.status_code == 200, head.text
    assert head.json()["defaults"] == DEFAULTS
    assert head.json()["variables"]["email_change"] == ["email", "minutes", "name", "siteName"]
    assert "stockCode" in head.json()["variables"]["price_alert"]
    assert "stockCode" not in head.json()["variables"]["email_change"]
    template = copy.deepcopy(DEFAULTS[1])
    template["subject"] = "{{siteName}} 合成模板"
    template["name"] = "Caller may not rename immutable template"
    template["kind"] = "message"
    command = {"requestId": str(uuid4()), "expectedRevision": 0, "template": template}
    done = await client.post("/api/system/mail-templates/operations", json=command)
    assert done.status_code == 200, done.text
    result = done.json()
    assert (
        result["state"] == "completed"
        and result["revision"] == 1
        and result["template"]["name"] == DEFAULTS[1]["name"]
        and result["template"]["kind"] == "code"
    )
    assert (await client.post("/api/system/mail-templates/operations", json=command)).json() == result
    assert (
        await client.get("/api/system/mail-templates/operations/" + command["requestId"])
    ).json() == result
    changed = copy.deepcopy(command)
    changed["template"]["subject"] = "changed"
    assert (await client.post("/api/system/mail-templates/operations", json=changed)).status_code == 409
    changed["requestId"] = str(uuid4())
    stale = await client.post("/api/system/mail-templates/operations", json=changed)
    assert stale.json()["state"] == "failed" and stale.json()["status"] == 409
    assert (await client.post("/api/system/mail-templates/operations", json=changed)).json() == stale.json()
    public = (await client.get("/api/auth/mail-templates")).json()["templates"]
    assert public[1]["subject"] == "{{siteName}} 合成模板"
    # Reading editor presets does not reset saved configuration or emit mail.
    refreshed = (await client.get("/api/system/mail-templates")).json()
    assert refreshed["revision"] == 1
    assert refreshed["templates"][1]["subject"] == "{{siteName}} 合成模板"
    assert refreshed["defaults"] == DEFAULTS
    assert refreshed["defaults"][1]["subject"] != refreshed["templates"][1]["subject"]
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM mail_template_operations")).fetchone())[
            "n"
        ] == 2
        assert (await (await conn.execute("SELECT count(*) n FROM identity_mail_outbox")).fetchone())["n"] == 0
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM audit_events WHERE action='mail.template.saved'")
            ).fetchone()
        )["n"] == 1


@pytest.mark.asyncio
async def test_non_admin_or_cross_origin_cannot_save_and_transaction_failure_has_no_half_template(
    client, admin, db, app, settings
):
    command = {"requestId": str(uuid4()), "expectedRevision": 0, "template": DEFAULTS[0]}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as anonymous:
        assert (
            await anonymous.post("/api/system/mail-templates/operations", json=command)
        ).status_code == 401
        assert (
            await anonymous.get("/api/system/mail-templates/operations/" + command["requestId"])
        ).status_code == 401
    assert (
        await client.post(
            "/api/system/mail-templates/operations",
            json=command,
            headers={"origin": "https://untrusted.invalid"},
        )
    ).status_code == 403
    from alcor_api.cli import create_user

    await create_user(settings, "TemplateUser", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as member:
        login = await member.post(
            "/api/session/login", json={"login": "TemplateUser", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        member.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await member.get("/api/system/mail-templates")).status_code == 403
        assert (await member.post("/api/system/mail-templates/operations", json=command)).status_code == 403
        assert (
            await member.get("/api/system/mail-templates/operations/" + command["requestId"])
        ).status_code == 403
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION synthetic_mail_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mail.template.saved' THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_mail_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_mail_audit_failure()",
            prepare=False,
        )
    failed = await client.post("/api/system/mail-templates/operations", json=command)
    assert failed.status_code == 503
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM mail_template_state")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM mail_template_operations")).fetchone()
        await conn.execute(
            "DROP TRIGGER synthetic_mail_audit_failure ON audit_events; DROP FUNCTION synthetic_mail_audit_failure()",
            prepare=False,
        )
    assert (await client.post("/api/system/mail-templates/operations", json=command)).json()[
        "state"
    ] == "completed"


def test_old_real_typescript_defaults_and_validation_are_preserved():
    from frozen_legacy import source_root

    root = source_root("ALCOR_MAIL_LEGACY_ROOT", ["lib/mailTemplateModel.ts"])
    module = Path(root) / "lib/mailTemplateModel.ts"
    assert module.is_file()
    js = (
        "import("
        + json.dumps(module.as_uri())
        + ').then(m=>{console.log(JSON.stringify({defaults:m.DEFAULT_MAIL_TEMPLATES,normalized:m.validateMailTemplate({...m.DEFAULT_MAIL_TEMPLATES[0],signature:"",body:"  {{email}}  "})}))})'
    )
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", js],
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    old = json.loads(result.stdout)
    assert old["defaults"] == DEFAULTS
    assert validate({**DEFAULTS[0], "signature": "", "body": "  {{email}}  "}) == old["normalized"]
    for change in ({"body": "{{code}}"}, {"subject": "x" * 161}, {"body": "x\x00y"}, {"id": "unknown"}):
        with pytest.raises(HTTPException):
            validate({**DEFAULTS[0], **change})
    safe = render_text(
        DEFAULTS[0],
        {
            "siteName": "A\r\nInjected: value",
            "email": "synthetic@example.invalid",
            "minutes": 30,
            "code": "123456",
        },
    )
    assert "\r" not in safe["subject"] and "\n" not in safe["subject"] and "123456" in safe["text"]


@pytest.mark.asyncio
async def test_explicit_close_serializes_late_save_and_keeps_existing_completed_receipt(client, admin, db):
    import asyncio

    unknown = str(uuid4())
    closed = (
        await client.post("/api/system/mail-templates/operations/" + unknown + "/close", json={})
    ).json()
    assert closed["state"] == "failed" and closed["revision"] == 0
    command = {"requestId": unknown, "expectedRevision": 0, "template": DEFAULTS[0]}
    assert (await client.post("/api/system/mail-templates/operations", json=command)).status_code == 409
    assert (await client.get("/api/system/mail-templates/operations/" + unknown)).json() == closed
    command["requestId"] = str(uuid4())
    saved, closing = await asyncio.gather(
        client.post("/api/system/mail-templates/operations", json=command),
        client.post("/api/system/mail-templates/operations/" + command["requestId"] + "/close", json={}),
    )
    result = (await client.get("/api/system/mail-templates/operations/" + command["requestId"])).json()
    assert result["state"] in ("completed", "failed")
    assert closing.json() == result
    if saved.status_code == 200:
        assert saved.json() == result
    else:
        assert saved.status_code == 409 and result["state"] == "failed"
    async with db.connection() as conn:
        count = (await (await conn.execute("SELECT count(*) n FROM mail_template_state")).fetchone())["n"]
        assert count == (1 if result["state"] == "completed" else 0)
    assert (
        await client.post(
            "/api/system/mail-templates/operations/" + command["requestId"] + "/close", json={"template": {}}
        )
    ).status_code == 400


@pytest.mark.asyncio
async def test_saved_template_is_sealed_into_real_identity_queue_and_later_edit_cannot_change_it(
    client, admin, app, settings
):
    from test_identity_email_flows import deliver, enable, request

    captured = enable(app, settings)
    template = {
        **DEFAULTS[4],
        "subject": "合成首版 {{siteName}}",
        "body": "核对 {{email}} 的注册；{{minutes}} 分钟有效。",
    }
    changed = await client.post(
        "/api/system/mail-templates/operations",
        json={"requestId": str(uuid4()), "expectedRevision": 0, "template": template},
    )
    assert changed.json()["state"] == "completed"
    await request(client, "synthetic-queue@example.invalid")
    template = {**template, "subject": "合成后版"}
    assert (
        await client.post(
            "/api/system/mail-templates/operations",
            json={"requestId": str(uuid4()), "expectedRevision": 1, "template": template},
        )
    ).json()["state"] == "completed"
    await deliver(app)
    assert captured[-1]["subject"] == "合成首版 Alcor"
    assert "synthetic-queue@example.invalid" in captured[-1]["text"] and "30 分钟有效" in captured[-1]["text"]


@pytest.mark.asyncio
async def test_actual_old_route_and_v2_optional_credential_policy_golden(client):
    runner=Path(__file__).parent/'mail_templates_candidate/old_routes.cjs'
    from frozen_legacy import source_root
    root=source_root('ALCOR_MAIL_LEGACY_ROOT', ['lib/mailTemplateModel.ts', 'lib/api.ts', 'lib/appApiV2.ts', 'lib/appApiV2Policy.ts', 'app/api/v1/auth/mail-templates/route.ts', 'app/api/v2/auth/mail-templates/route.ts'])
    result=await asyncio.to_thread(subprocess.run,['node','--experimental-vm-modules',str(runner),str(root)],text=True,capture_output=True,check=True,timeout=10)
    for case in json.loads(result.stdout):
        headers={} if case['authorization'] is None else {'authorization':case['authorization']}
        response=await client.get(f"/api/v{case['version']}/auth/mail-templates",headers=headers)
        assert response.status_code==case['status']
        assert response.json()==case['body']


@pytest.mark.asyncio
async def test_v2_public_template_with_valid_native_token_then_revocation_never_falls_back_to_cookie(client,admin,db):
    from alcor_api.native_app_auth import issue_grant
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        pair=await issue_grant(conn,user,'portfolio.read','Synthetic template reader')
    headers={'authorization':'Bearer '+pair['access_token']}
    read=await client.get('/api/v2/auth/mail-templates',headers=headers);assert read.status_code==200,read.text
    async with db.connection() as conn:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE user_id=%s',(admin,))
    denied=await client.get('/api/v2/auth/mail-templates',headers=headers);assert denied.status_code==401
    assert (await client.get('/api/system/mail-templates')).status_code==200
