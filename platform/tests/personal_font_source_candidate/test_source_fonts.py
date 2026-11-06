import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import psycopg
import pytest
from alcor_api.cli import create_user
from alcor_api.source_snapshot import sha
from legacy_source.test_source_authority import authorized
from test_account_admin import body_for, login

P = "/api/personal-font-import"


async def test_registration_configuration_state_does_not_hide_archived_owner_work(client, admin, old_pg, source_file, settings):
    assert (await client.get(P + "/registration-options")).json()["configuration"]["state"] == "configured"
    p, _ = await permission(client, admin, old_pg, source_file)
    p = await consent(client, p)
    cap, _ = await capture(client, p)
    registered = settings.font_import_registry_path
    settings.font_import_registry_path = None
    missing = (await client.get(P + "/registration-options")).json()
    assert missing["configuration"]["state"] == "not_configured" and missing["items"] == []
    settings.font_import_registry_path = registered.parent / "missing-private-registry.json"
    unavailable = (await client.get(P + "/registration-options")).json()
    assert unavailable["configuration"]["state"] == "unavailable" and unavailable["items"] == []
    listing = (await client.get(P + "/permissions")).json()
    assert any(row["id"] == cap["id"] for row in listing["captures"])
    response = await client.post(P + "/operations", json=await preview(client, cap))
    assert response.status_code == 200 and response.json()["state"] == "completed", response.text


async def permission(client, admin, old_pg, source_file):
    grant = await authorized(client, admin, old_pg)
    command = {
        "requestId": str(uuid4()),
        "grantId": grant["grantId"],
        "grantRevision": grant["grantRevision"],
        "originalId": source_file[1].name,
        "evidenceRef": "Synthetic admin/operator migration attestation",
    }
    response = await client.post(P + "/permissions", json=command)
    assert response.status_code == 200, response.text
    return response.json()["permission"], command


async def consent(client, p, *, approve=True, password="Synthetic9Pass", name="Owner Confirmed Name"):
    command = {
        "requestId": str(uuid4()),
        "revision": p["revision"],
        "approve": approve,
        "acknowledgeUnverifiedUploader": True,
        "name": name,
        "password": password,
        "code": "",
    }
    response = await client.post(P + "/permissions/" + p["id"] + "/consent", json=command)
    assert response.status_code == 200, response.text
    return response.json()["permission"]


async def capture(client, p):
    command = {"requestId": str(uuid4()), "permissionId": p["id"], "permissionRevision": p["revision"]}
    response = await client.post(P + "/captures", json=command)
    assert response.status_code == 200, response.text
    return response.json()["capture"], command


async def preview(client, cap):
    response = await client.post(P + "/preview", json={"captureId": cap["id"]})
    assert response.status_code == 200, response.text
    value = response.json()
    return {
        "requestId": str(uuid4()),
        "captureId": cap["id"],
        "permissionRevision": value["plan"]["permissionRevision"],
        "expectedRevision": value["plan"]["expectedRevision"],
        "preview": value["preview"],
    }


async def ready(client, admin, old_pg, source_file):
    p, _ = await permission(client, admin, old_pg, source_file)
    p = await consent(client, p)
    cap, command = await capture(client, p)
    return p, cap, command


async def test_explicit_admin_owner_evidence_claim_archive_original_and_old_id_alias(
    client, admin, old_pg, source_file, settings, app
):
    p, register = await permission(client, admin, old_pg, source_file)
    assert p["state"] == "pending_owner" and not p["historicalUploaderVerified"]
    blocked = await client.post(
        P + "/captures",
        json={"requestId": str(uuid4()), "permissionId": p["id"], "permissionRevision": p["revision"]},
    )
    assert blocked.status_code == 409
    assert not settings.file_root.exists()
    bad = await client.post(
        P + "/permissions/" + p["id"] + "/consent",
        json={
            "requestId": str(uuid4()),
            "revision": p["revision"],
            "approve": True,
            "acknowledgeUnverifiedUploader": True,
            "name": "Confirmed",
            "password": "BadSynthetic9",
            "code": "",
        },
    )
    assert bad.status_code == 403
    p = await consent(client, p)
    assert p["revision"] == 2
    cap, captured_command = await capture(client, p)
    assert (await client.get(cap["originalPath"])).content == source_file[2]
    result = await client.post(P + "/operations", json=await preview(client, cap))
    assert result.status_code == 200, result.text
    value = result.json()
    assert value["font"]["name"] == "Owner Confirmed Name"
    assert value["font"]["id"].startswith("custom-1-")
    assert value["originalId"].startswith("custom-783-")
    assert not value["entireSourceComplete"] and not value["historicalUploaderVerified"]
    for path in [
        value["font"]["contentPath"],
        "/uploads/fonts/" + source_file[1].name,
        "/api/upload-files/fonts/" + source_file[1].name,
    ]:
        assert (await client.get(path)).content == source_file[2]
        assert (await client.get(path, headers={"Range": "bytes=0-3"})).content == source_file[2][:4]
    assert (await client.get(P + "/operations/" + captured_command["requestId"])).json()["capture"] == cap
    assert (await client.post(P + "/permissions", json=register)).json()["permission"][
        "state"
    ] == "pending_owner"
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM legacy_source_owner_claims WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 1
        assert (await (await conn.execute("SELECT count(*) n FROM legacy_source_heads")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM internal_orders")).fetchone())["n"] == 0
        row = await (
            await conn.execute(
                "SELECT evidence FROM personal_font_source_captures WHERE owner_id=%s", (admin,)
            )
        ).fetchone()
        evidence = json.loads(bytes(row["evidence"]))
        assert evidence["sidecar"]["state"] == "name" and evidence["name"] == "Owner Confirmed Name"
        assert evidence["sidecar"]["sha256"] == sha(
            (source_file[1].parent / (source_file[1].name + ".json")).read_bytes()
        )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        assert (await anonymous.get(cap["originalPath"])).status_code == 401
        assert (await anonymous.get("/uploads/fonts/" + source_file[1].name)).status_code == 401


async def test_expired_source_offline_archive_still_applies_but_no_new_capture(
    client, admin, old_pg, source_file, settings
):
    p, cap, _ = await ready(client, admin, old_pg, source_file)
    doc = json.loads(settings.legacy_source_registry_path.read_bytes())
    doc["sources"][0]["migrationWindow"] = {
        "notBefore": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
        "expiresAt": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
        "state": "active",
    }
    settings.legacy_source_registry_path.write_text(json.dumps(doc))
    source_file[0].rename(source_file[0].with_name("offline-old-root"))
    response = await client.post(
        P + "/captures",
        json={"requestId": str(uuid4()), "permissionId": p["id"], "permissionRevision": p["revision"]},
    )
    assert response.status_code == 409
    assert (await client.get(cap["originalPath"])).content == source_file[2]
    proof = await preview(client, cap)
    result = await client.post(P + "/operations", json=proof)
    assert result.status_code == 200, result.text
    assert result.json()["state"] == "completed"
    assert (await client.get(P + "/permissions")).json()["items"][0]["window"]["state"] == "expired"


async def test_original_uuid_cas_one_winner_and_repeat_no_duplicate_font(
    client, admin, old_pg, source_file, app
):
    _p, cap, _ = await ready(client, admin, old_pg, source_file)
    first = await preview(client, cap)
    second = {**first, "requestId": str(uuid4())}
    results = await asyncio.gather(
        client.post(P + "/operations", json=first), client.post(P + "/operations", json=second)
    )
    assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]
    index = next(i for i, r in enumerate(results) if r.status_code == 200)
    winner = [first, second][index]
    assert (await client.post(P + "/operations", json=winner)).json() == results[index].json()
    assert (await client.get(P + "/operations/" + winner["requestId"])).json() == results[index].json()
    bad = await client.post(
        "/api/personal-fonts",
        data={"requestId": winner["requestId"], "expectedRevision": "1"},
        files={"file": ("Same.ttf", source_file[2], "application/octet-stream")},
    )
    assert bad.status_code == 409
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM personal_fonts WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"] == 1


async def test_close_before_or_during_capture_stops_late_stage_and_preserves_receipt(
    client, admin, old_pg, source_file, app, settings
):
    p, _ = await permission(client, admin, old_pg, source_file)
    p = await consent(client, p)
    entered, release = asyncio.Event(), asyncio.Event()

    async def pause():
        entered.set()
        await release.wait()

    app.state.font_source_import.after_read = pause
    command = {"requestId": str(uuid4()), "permissionId": p["id"], "permissionRevision": p["revision"]}
    running = asyncio.create_task(client.post(P + "/captures", json=command))
    await asyncio.wait_for(entered.wait(), 10)
    close = await client.post(
        P + "/operations/" + command["requestId"] + "/close", json={"expectedKind": "capture"}
    )
    assert close.status_code == 200 and close.json()["canceled"]
    release.set()
    assert (await running).json() == close.json()
    assert (await client.post(P + "/captures", json=command)).json() == close.json()
    assert not settings.file_root.exists()
    future = str(uuid4())
    closed = (
        await client.post(P + "/operations/" + future + "/close", json={"expectedKind": "apply"})
    ).json()
    assert (await client.get(P + "/operations/" + future)).json() == closed


@pytest.mark.parametrize("unsafe", ["symlink", "hardlink", "corrupt", "oversize"])
async def test_bad_old_original_is_blocked_without_target_or_media_row(
    client, admin, old_pg, source_file, app, settings, unsafe
):
    p, _ = await permission(client, admin, old_pg, source_file)
    p = await consent(client, p)
    path = source_file[1]
    if unsafe == "symlink":
        path.unlink()
        path.symlink_to("no-owner-original")
    elif unsafe == "hardlink":
        __import__("os").link(path, path.with_name("another-link"))
    else:
        path.chmod(0o600)
        path.write_bytes(b"x" * (10485761 if unsafe == "oversize" else 100))
    command = {"requestId": str(uuid4()), "permissionId": p["id"], "permissionRevision": p["revision"]}
    response = await client.post(P + "/captures", json=command)
    assert response.status_code == 409 and response.json()["state"] == "failed", response.text
    assert (await client.get(P + "/operations/" + command["requestId"])).json() == response.json()
    assert not settings.file_root.exists()
    async with app.state.db.connection() as conn:
        for table in ("personal_fonts", "personal_font_source_captures", "resource_media_objects"):
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))
                ).fetchone()
            )["n"] == 0


async def test_revocation_blocks_apply_but_history_read_and_active_disabled_cleanup_guard(
    client, admin, old_pg, source_file, app
):
    p, cap, _ = await ready(client, admin, old_pg, source_file)
    proof = await preview(client, cap)
    await consent(client, p, approve=False)
    result = await client.post(P + "/operations", json=proof)
    assert result.status_code == 409
    assert (await client.get(cap["originalPath"])).content == source_file[2]
    for table in (
        "personal_font_source_permissions",
        "personal_font_source_captures",
        "personal_font_source_operations",
    ):
        with pytest.raises(psycopg.Error):
            async with app.state.db.connection() as conn, conn.transaction():
                await conn.execute("UPDATE users SET active=false WHERE id=%s", (admin,))
                await conn.execute("DELETE FROM " + table + " WHERE owner_id=%s", (admin,))


async def test_account_close_retires_source_font_refs_but_keeps_source_claim_and_old_files(
    client, admin, old_pg, source_file, app, settings
):
    _p, cap, _ = await ready(client, admin, old_pg, source_file)
    result = await client.post(P + "/operations", json=await preview(client, cap))
    assert result.status_code == 200, result.text
    await create_user(settings, "SurvivingSourceFontAdmin", "Synthetic9Pass", role="admin")
    peer = await login(app, "SurvivingSourceFontAdmin")
    before = await body_for(client, admin)
    closed = await client.post(
        "/api/account/close",
        json={k: before[k] for k in ("request_id", "revision")} | {"current_password": "Synthetic9Pass"},
    )
    assert closed.status_code == 200, closed.text
    assert (await client.get(cap["originalPath"])).status_code == 401
    assert (await peer.get(cap["originalPath"])).status_code == 404
    assert source_file[1].read_bytes() == source_file[2]
    async with app.state.db.connection() as conn:
        for table in (
            "personal_fonts",
            "personal_font_source_aliases",
            "personal_font_source_captures",
            "personal_font_source_permissions",
            "personal_font_source_operations",
            "resource_media_objects",
        ):
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))
                ).fetchone()
            )["n"] == 0
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM legacy_source_owner_claims WHERE owner_id=%s", (admin,)
                )
            ).fetchone()
        )["n"] == 1
    await peer.aclose()


async def test_other_owner_admin_permission_csrf_and_duplicate_fields_do_not_expose_or_mutate(
    client, admin, old_pg, source_file, app, settings
):
    p, cap, _ = await ready(client, admin, old_pg, source_file)
    await create_user(settings, "IndependentFontOwner", "Synthetic9Pass", role="user")
    member = await login(app, "IndependentFontOwner")
    assert (await member.get(cap["originalPath"])).status_code == 404
    assert (await member.get(P + "/permissions")).json()["items"] == []
    assert (await member.get(P + "/registration-options")).status_code == 403
    assert (await member.post(P + "/preview", json={"captureId": cap["id"]})).status_code == 404
    assert (
        await member.get(cap["originalPath"], headers={"Authorization": "Bearer invalid"})
    ).status_code == 403
    assert (await client.get(cap["originalPath"] + "?path=arbitrary")).status_code == 400
    body = await preview(client, cap)
    assert (
        await client.post(P + "/operations", json=body, headers={"x-csrf-token": "wrong"})
    ).status_code == 403
    assert (
        await client.post(
            P + "/operations",
            content='{"requestId":"' + str(uuid4()) + '","requestId":"' + str(uuid4()) + '"}',
            headers={"content-type": "application/json"},
        )
    ).status_code == 422
    assert (
        await client.post(
            P + "/captures",
            json={
                "requestId": str(uuid4()),
                "permissionId": p["id"],
                "permissionRevision": p["revision"],
                "path": "/untrusted-root",
            },
        )
    ).status_code == 422
    await member.aclose()


async def test_fsync_failure_does_not_publish_capture_or_target(
    client, admin, old_pg, source_file, app, settings, monkeypatch
):
    p, _ = await permission(client, admin, old_pg, source_file)
    p = await consent(client, p)
    from alcor_api import resource_media

    def failed(_):
        raise OSError("synthetic fsync failure")

    with monkeypatch.context() as patch:
        patch.setattr(resource_media.os, "fsync", failed)
        response = await client.post(
            P + "/captures",
            json={"requestId": str(uuid4()), "permissionId": p["id"], "permissionRevision": p["revision"]},
        )
    assert response.status_code == 409 and response.json()["state"] == "failed", response.text
    async with app.state.db.connection() as conn:
        for table in ("personal_font_source_captures", "resource_media_objects", "personal_fonts"):
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))
                ).fetchone()
            )["n"] == 0
    cap, _ = await capture(client, p)
    assert (await client.get(cap["originalPath"])).content == source_file[2]


async def test_failed_apply_rolls_back_font_alias_revision_but_keeps_exact_archived_original(
    client, admin, old_pg, source_file, app
):
    from fastapi import HTTPException

    _p, cap, _ = await ready(client, admin, old_pg, source_file)

    async def stop():
        raise HTTPException(503, "Synthetic commit guard")

    app.state.font_source_import.after_store = stop
    command = await preview(client, cap)
    response = await client.post(P + "/operations", json=command)
    assert response.status_code == 503 and response.json()["state"] == "failed", response.text
    assert (await client.get(P + "/operations/" + command["requestId"])).json() == response.json()
    assert (await client.post(P + "/operations", json=command)).json() == response.json()
    assert (await client.get("/api/personal-fonts")).json()["revision"] == 0
    assert (await client.get(cap["originalPath"])).content == source_file[2]
    async with app.state.db.connection() as conn:
        for table in ("personal_fonts", "personal_font_source_aliases"):
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))
                ).fetchone()
            )["n"] == 0
    app.state.font_source_import.after_store = None
    result = await client.post(P + "/operations", json=await preview(client, cap))
    assert result.status_code == 200 and result.json()["state"] == "completed"


@pytest.mark.parametrize("extension", ["ttf", "otf", "woff", "woff2"])
async def test_real_source_four_formats_keep_original_bytes_and_registered_old_id(
    client, admin, old_pg, source_file, extension
):
    from font_fixtures import font_bytes

    raw = font_bytes(extension, seed=3)
    path = source_file[0] / ("custom-937-" + sha(raw) + "." + extension)
    path.write_bytes(raw)
    path.chmod(0o444)
    item = source_file[0], path, raw
    _, cap, _ = await ready(client, admin, old_pg, item)
    response = await client.post(P + "/operations", json=await preview(client, cap))
    assert response.status_code == 200, response.text
    assert response.json()["font"]["mediaType"] == "font/" + extension
    assert (await client.get(response.json()["font"]["contentPath"])).content == raw
    assert (await client.get("/uploads/fonts/" + path.name)).content == raw
