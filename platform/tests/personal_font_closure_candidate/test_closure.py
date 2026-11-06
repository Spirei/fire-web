import psycopg
import pytest
from alcor_api.cli import create_user
from alcor_api.resource_media import ResourceMedia
from font_fixtures import font_bytes
from test_account_admin import body_for, login
from test_admin_attachments import upload as upload_shared
from test_personal_fonts import P, upload
from test_watch_group_icons import group
from test_watch_group_icons import upload as upload_icon
from watch_group_source_icons_candidate.test_source_icons import (
    icon_apply,
    icon_capture,
    icon_preview,
    source,
)


async def test_real_closed_admin_retires_font_icon_and_source_media_without_breaking_global_byte_reference(
    client, admin, app, settings, old_pg, icon_source
):
    _, manifest, _ = await source(client, admin, old_pg)
    captured, _ = await icon_capture(client, manifest)
    source_image, _ = await icon_apply(client, captured, await icon_preview(client, captured))
    gid = await group(client, "Current icon")
    image, _ = await upload_icon(client, gid)
    font, _ = await upload(client)
    assert font.status_code == 200 and image.status_code == 200
    raw = font_bytes()
    shared, _ = await upload_shared(client, "Shared.ttf", raw)
    assert shared.status_code == 200, shared.text
    shared_path = shared.json()["downloadPath"]
    uid = await create_user(settings, "SurvivingFontAdmin", "Synthetic9Pass", role="admin")
    peer = await login(app, "SurvivingFontAdmin")
    tables = [
        "personal_fonts",
        "personal_font_operations",
        "watch_group_icon_versions",
        "watch_group_source_icon_captures",
        "watch_group_source_icon_links",
    ]
    for table in tables:
        with pytest.raises(psycopg.Error):
            async with app.state.db.connection() as conn, conn.transaction():
                await conn.execute("UPDATE users SET active=false WHERE id=%s", (admin,))
                await conn.execute("DELETE FROM " + table + " WHERE owner_id=%s", (admin,))
    before = await body_for(client, admin)
    closed = await client.post(
        "/api/account/close",
        json={key: before[key] for key in ("request_id", "revision", "current_password")}
        | {"current_password": "Synthetic9Pass"},
    )
    assert closed.status_code == 200, closed.text
    private = [
        font.json()["font"]["originalPath"],
        image.json()["icon"]["originalPath"],
        source_image["icon"]["originalPath"],
        captured["originalPath"],
    ]
    for path in private:
        assert (await client.get(path)).status_code == 401
        assert (await peer.get(path)).status_code == 404
    import os
    import time

    for original in (settings.file_root / "resource-media").iterdir():
        os.utime(original, (time.time() - 90000, time.time() - 90000))
    async with app.state.db.connection() as conn:
        for table in tables + ["personal_font_scopes", "resource_media_objects"]:
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))
                ).fetchone()
            )["n"] == 0
        for table in [
            "watch_group_source_manifests",
            "watch_group_source_bindings",
            "watch_group_import_operations",
        ]:
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))
                ).fetchone()
            )["n"] > 0
        await ResourceMedia(settings).reconcile_orphans(conn)
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (uid,))).fetchone())[
            "active"
        ]
    assert {p.name for p in (settings.file_root / "resource-media").iterdir()} == {
        font.json()["font"]["sha256"]
    }
    assert icon_source[1].read_bytes().startswith(b"<?xml")
    shared_bytes = await peer.get(shared_path)
    assert shared_bytes.status_code == 200 and shared_bytes.content == raw
    await peer.aclose()


async def test_admin_removal_of_member_with_font_and_icon_is_atomic_and_old_session_cannot_reuse_receipts(
    client, admin, settings, app
):
    owner = await create_user(settings, "FontClosureMember", "Synthetic9Pass", role="user")
    member = await login(app, "FontClosureMember")
    gid = await group(member)
    image, _ = await upload_icon(member, gid)
    font, operation = await upload(member)
    assert font.status_code == 200 and image.status_code == 200
    before = await body_for(client, owner)
    data = {key: before[key] for key in ("request_id", "revision", "current_password")}
    removed = await client.request("DELETE", "/api/users/" + owner, json=data)
    assert removed.status_code == 200, removed.text
    assert (await client.request("DELETE", "/api/users/" + owner, json=data)).json() == removed.json()
    assert (await member.get(P + "/operations/" + operation["requestId"])).status_code == 401
    assert (await member.get(font.json()["font"]["originalPath"])).status_code == 401
    async with app.state.db.connection() as conn:
        for table in [
            "personal_fonts",
            "personal_font_operations",
            "watch_group_icon_versions",
            "resource_media_objects",
        ]:
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (owner,))
                ).fetchone()
            )["n"] == 0
    await member.aclose()
