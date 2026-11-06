import asyncio
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.native_app_auth import issue_grant
from alcor_api.resource_media import ResourceMedia

PNG = b"\x89PNG\r\n\x1a\nSYNTHETIC-PRIVATE-ICON"
SVG = b'<?xml version="1.0"?><!-- by TradingView --><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
BASE = "/api/watch-groups"


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path / "icon-files"


async def group(client, name="Personal"):
    before = (await client.get(BASE)).json()
    result = await client.post(
        BASE + "/operations",
        json={
            "requestId": str(uuid4()),
            "expectedRevision": before["revision"],
            "action": "create",
            "data": {"name": name},
        },
    )
    assert result.status_code == 200, result.text
    return result.json()["group"]["id"]


async def upload(client, gid, raw=PNG, name="source.png", rid=None, revision=None, headers=None):
    revision = (await client.get(BASE)).json()["revision"] if revision is None else revision
    data = {"requestId": rid or str(uuid4()), "expectedRevision": str(revision)}
    response = await client.post(
        BASE + "/" + gid + "/icon", data=data, files={"file": (name, raw)}, headers=headers
    )
    return response, data


async def native(db, owner, scope="portfolio.read portfolio.write"):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        pair = await issue_grant(conn, user, scope, "Synthetic personal icons")
    return {"authorization": "Bearer " + pair["access_token"]}, pair


async def test_personal_raw_svg_history_clear_delete_and_original_uuid(client, admin, app, settings):
    gid = await group(client)
    first, body = await upload(client, gid, SVG, "source.svg")
    assert first.status_code == 200, first.text
    one = first.json()
    media = one["icon"]
    assert media["url"].startswith("/uploads/asset/group/" + admin + "/" + gid + "/")
    served = await client.get(media["url"])
    assert served.status_code == 200 and served.content.startswith(b"<!-- by alcor -->\n<svg")
    assert media["sha256"] != media["originalSha256"]
    original = await client.get(media["originalPath"])
    assert original.content == SVG and original.headers["content-type"] == "application/octet-stream"
    assert (await client.get(media["contentPath"])).content == served.content
    repeated, _ = await upload(
        client, gid, SVG, "source.svg", rid=body["requestId"], revision=int(body["expectedRevision"])
    )
    assert repeated.json() == one
    assert (await client.get(BASE + "/operations/" + one["requestId"])).json() == one
    second, _ = await upload(client, gid, SVG.replace(b"M0 0", b"M1 1"), "source.svg")
    assert second.status_code == 200 and (await client.get(media["url"])).content == served.content
    for action, data in [("update", {"id": gid, "icon": ""}), ("delete", {"id": gid})]:
        revision = (await client.get(BASE)).json()["revision"]
        response = await client.post(
            BASE + "/operations",
            json={"requestId": str(uuid4()), "expectedRevision": revision, "action": action, "data": data},
        )
        assert response.status_code == 200, response.text
        assert (await client.get(media["originalPath"])).content == SVG
        assert (await client.get(BASE + "/operations/" + one["requestId"])).json() == one
    late, _ = await upload(client, gid)
    assert late.status_code == 404 and late.json()["state"] == "failed"
    async with app.state.db.connection() as conn:
        await ResourceMedia(settings).reconcile_orphans(conn)
        assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_objects")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM watch_group_icon_versions")).fetchone())[
            "n"
        ] == 2
    assert (settings.file_root / "resource-media" / media["originalSha256"]).read_bytes() == SVG


@pytest.mark.parametrize("version", [1, 2])
async def test_actual_legacy_format_custom_group_upload_and_put_known_reference_or_empty(
    client, admin, db, version
):
    gid = await group(client)
    headers, _ = await native(db, admin)
    rid = str(uuid4())
    result = await client.post(
        f"/api/v{version}/watch-groups/{gid}/icon",
        headers={**headers, "x-alcor-request-id": rid},
        files={"file": ("animate.gif", b"GIF89a-SYNTHETIC-ANIMATION")},
    )
    assert result.status_code == 200, result.text
    assert result.headers["x-alcor-request-id"] == rid
    value = result.json()
    assert value["code"] == 0 and set(value["data"]["group"]) == {
        "id",
        "name",
        "icon",
        "sort",
        "visible",
        "kind",
        "market",
    }
    icon = value["data"]["group"]["icon"]
    assert (await client.get(icon, headers=headers)).content == b"GIF89a-SYNTHETIC-ANIMATION"
    for supplied in ["", icon]:
        updated = await client.put(
            f"/api/v{version}/watch-groups/{gid}", headers=headers, json={"icon": supplied}
        )
        assert updated.status_code == 200 and updated.json()["data"]["group"]["icon"] == supplied, (
            updated.text
        )
    blocked = await client.put(
        f"/api/v{version}/watch-groups/{gid}",
        headers=headers,
        json={"icon": "https://unmapped.example.invalid/private.png"},
    )
    assert blocked.status_code == 409 and "映射" in blocked.text
    unknown = await client.post(
        f"/api/v{version}/watch-groups/unmapped-old-id/icon", headers=headers, files={"file": ("x.png", PNG)}
    )
    assert unknown.status_code == 404 and "映射" in unknown.text


async def test_personal_owner_scope_csrf_and_shared_assets_never_authorize_icons(
    client, admin, app, settings, db
):
    gid = await group(client)
    first, _ = await upload(client, gid)
    media = first.json()["icon"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        assert (await other.get(media["url"])).status_code == 401
        user = await create_user(settings, "IconUser", "OtherSynthetic9", role="user")
        login = await other.post(
            "/api/session/login", json={"login": "IconUser", "password": "OtherSynthetic9"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        for path in [
            media["url"],
            media["originalPath"],
            media["contentPath"],
            BASE + "/operations/" + first.json()["requestId"],
        ]:
            assert (await other.get(path)).status_code == 404
        own = await group(other, "Own group")
        own_upload, _ = await upload(other, own)
        assert own_upload.status_code == 200
        revision = (await other.get(BASE)).json()["revision"]
        for path in [media["url"], "/uploads/asset/group/admin-shared.svg"]:
            blocked = await other.post(
                BASE + "/operations",
                json={
                    "requestId": str(uuid4()),
                    "expectedRevision": revision,
                    "action": "update",
                    "data": {"id": own, "icon": path},
                },
            )
            assert blocked.status_code == 409 and "映射" in blocked.text
        assert user != admin
    bad, _ = await upload(client, gid, headers={"x-csrf-token": "invalid"})
    assert bad.status_code == 403
    read, _ = await native(db, admin, "portfolio.read")
    denied, _ = await upload(client, gid, headers=read)
    assert denied.status_code == 403
    assert (await client.get(media["contentPath"], headers=read)).status_code == 200
    assert (await client.get(media["url"], headers={"authorization": "Bearer invalid"})).status_code in (
        401,
        403,
    )


async def test_exact_two_mib_formats_unsafe_svg_range_and_duplicate_queries(client, admin):
    gid = await group(client)
    raw = b"GIF89a" + b"x" * (2097152 - 6)
    accepted, _ = await upload(client, gid, raw, "exact.gif")
    assert accepted.status_code == 200, accepted.text
    media = accepted.json()["icon"]
    assert (await client.get(media["originalPath"])).content == raw
    too_large, body = await upload(client, gid, raw + b"x", "over.gif")
    assert too_large.status_code == 413
    assert (await client.get(BASE + "/operations/" + body["requestId"])).json() == too_large.json()
    unsafe, _ = await upload(
        client, gid, b"<svg><image href='https://unmapped.example.invalid/a'/></svg>", "bad.svg"
    )
    assert unsafe.status_code == 400
    assert (await client.get(media["url"], headers={"range": "bytes=-7"})).content == raw[-7:]
    assert (await client.get(media["url"] + "&sha256=" + media["sha256"])).status_code == 400
    assert (await client.get(media["url"].split("?")[0] + "?sha256=invalid")).status_code == 400
    assert (await client.get(media["url"].replace(media["sha256"], "0" * 64))).status_code == 404


async def test_real_same_uuid_and_cas_race_and_deleted_group_never_revives(client, admin, app):
    gid = await group(client)
    revision = (await client.get(BASE)).json()["revision"]
    rid = str(uuid4())
    results = await asyncio.gather(
        upload(client, gid, rid=rid, revision=revision), upload(client, gid, rid=rid, revision=revision)
    )
    assert all(r.status_code == 200 for r, _ in results) and results[0][0].json() == results[1][0].json()
    revision = (await client.get(BASE)).json()["revision"]
    results = await asyncio.gather(
        upload(client, gid, raw=PNG + b"one", revision=revision),
        upload(client, gid, raw=PNG + b"two", revision=revision),
    )
    assert sorted(r.status_code for r, _ in results) == [200, 409]
    for r, body in results:
        assert (await client.get(BASE + "/operations/" + body["requestId"])).json() == r.json()
    revision = (await client.get(BASE)).json()["revision"]
    delete = client.post(
        BASE + "/operations",
        json={
            "requestId": str(uuid4()),
            "expectedRevision": revision,
            "action": "delete",
            "data": {"id": gid},
        },
    )
    results = await asyncio.gather(upload(client, gid, revision=revision), delete)
    assert sorted([results[0][0].status_code, results[1].status_code]) == [200, 409]
    current = (await client.get(BASE)).json()
    if any(g["id"] == gid for g in current["groups"]):
        assert (
            await client.post(
                BASE + "/operations",
                json={
                    "requestId": str(uuid4()),
                    "expectedRevision": current["revision"],
                    "action": "delete",
                    "data": {"id": gid},
                },
            )
        ).status_code == 200
    late, _ = await upload(client, gid)
    assert late.status_code == 404
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT deleted_at IS NOT NULL dead FROM watch_groups WHERE owner_id=%s AND id=%s",
                    (admin, gid),
                )
            ).fetchone()
        )["dead"]


async def test_late_scope_revocation_and_real_file_fsync_failure_do_not_publish(
    client, admin, db, app, monkeypatch
):
    import os
    import stat

    from alcor_api import resource_media

    gid = await group(client)
    first, _ = await upload(client, gid)
    before = first.json()
    revision = before["revision"]
    headers, pair = await native(db, admin)
    request = client.build_request(
        "POST",
        BASE + "/" + gid + "/icon",
        headers=headers,
        data={"requestId": str(uuid4()), "expectedRevision": str(revision)},
        files={"file": ("x.png", PNG + b"late")},
    )
    raw = await request.aread()

    async def chunks():
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE identity_app_grants SET scope='portfolio.read' WHERE id=%s", (pair["grant_id"],)
            )
        yield raw

    denied = await client.post(
        str(request.url),
        headers={**headers, "content-type": request.headers["content-type"]},
        content=chunks(),
    )
    assert denied.status_code == 403, denied.text
    current = await client.get(BASE + "/" + gid + "/icon")
    assert current.json()["icon"] == before["icon"]
    actual = os.fsync

    def fail_file(fd):
        if stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("synthetic disk flush failed")
        return actual(fd)

    with monkeypatch.context() as fault:
        fault.setattr(resource_media.os, "fsync", fail_file)
        failed, body = await upload(client, gid, PNG + b"flush failure")
    assert failed.status_code == 503 and failed.json()["state"] == "failed", failed.text
    assert (await client.get(BASE + "/operations/" + body["requestId"])).json() == failed.json()
    assert (await client.get(before["icon"]["originalPath"])).content == PNG
    assert (await client.get(BASE + "/" + gid + "/icon")).json()["icon"] == before["icon"]
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM watch_group_icon_versions")).fetchone())[
            "n"
        ] == 1


@pytest.mark.parametrize("version", [1, 2])
async def test_generated_legacy_failure_preserves_original_uuid_receipt(client, admin, db, version):
    gid = await group(client, "Failed original receipt")
    headers, _ = await native(db, admin)
    response = await client.post(
        f"/api/v{version}/watch-groups/{gid}/icon",
        files={"file": ("bad.svg", b"not an SVG")},
        headers=headers,
    )
    assert response.status_code == 400
    rid = response.headers.get("x-alcor-request-id")
    assert rid, "Persisted legacy failure must return its generated operation UUID"
    assert response.headers["x-alcor-request-id-mode"] == "generated_legacy"
    receipt = await client.get(BASE + "/operations/" + rid)
    assert receipt.status_code == 200
    assert receipt.json()["requestId"] == rid and receipt.json()["state"] == "failed"
