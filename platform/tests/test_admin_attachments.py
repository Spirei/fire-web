import hashlib
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.resource_media import ResourceMedia

P = "/api/admin/attachments"


@pytest_asyncio.fixture(autouse=True)
async def attachment_files(settings, tmp_path):
    settings.file_root = tmp_path.resolve() / "attachment-files"


async def upload(
    client, name="raw.bin", raw=b"original\x00bytes", revision=None, rid=None, conflict="error", directory=""
):
    revision = revision if revision is not None else (await client.get(P)).json()["revision"]
    data = {
        "requestId": rid or str(uuid4()),
        "expectedRevision": str(revision),
        "conflict": conflict,
        "dir": directory,
    }
    response = await client.post(P, data=data, files={"file": (name, raw, "application/octet-stream")})
    return response, data


async def test_zero_and_original_versions_replace_range_receipt_and_personal_namespace_isolation(
    client, admin, app, settings
):
    first = await client.get(P)
    assert first.status_code == 200 and first.json()["namespace"] == "admin_shared"
    assert not settings.file_root.exists()
    zero, _ = await upload(client, "empty.txt", b"")
    assert zero.status_code == 200, zero.text
    read = await client.get(zero.json()["downloadPath"])
    assert read.status_code == 200 and read.content == b"" and read.headers["content-length"] == "0"
    assert (await client.get(zero.json()["downloadPath"], headers={"range": "bytes=0-0"})).status_code == 416
    one, command = await upload(client)
    assert one.status_code == 200, one.text
    original = one.json()
    assert original["sha256"] == hashlib.sha256(b"original\x00bytes").hexdigest()
    repeated = await client.post(
        P, data=command, files={"file": ("raw.bin", b"original\x00bytes", "application/octet-stream")}
    )
    assert repeated.json() == original
    replacement, _ = await upload(client, raw=b"replacement", conflict="replace")
    assert replacement.status_code == 200, replacement.text
    assert (await client.get(original["downloadPath"])).content == b"original\x00bytes"
    assert (await client.get(replacement.json()["downloadPath"])).content == b"replacement"
    assert (await client.get(P + "/operations/" + original["requestId"])).json() == original
    ranged = await client.get(original["downloadPath"], headers={"range": "bytes=-5"})
    assert ranged.status_code == 206 and ranged.content == b"bytes"
    bad = await client.get(original["downloadPath"], headers={"range": "bytes=99-100"})
    assert bad.status_code == 416
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM resource_files")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_versions")).fetchone())[
            "n"
        ] == 3


async def test_global_other_admin_reads_and_tombstone_delete_original_uuid_survive_private_owner_cleanup(
    client, admin, app, settings
):
    created, _ = await upload(client, directory="报告/2026")
    assert created.status_code == 200, created.text
    await create_user(settings, "OtherAttachmentAdmin", "Synthetic9Pass", role="admin")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login", json={"login": "OtherAttachmentAdmin", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get(created.json()["downloadPath"])).content == b"original\x00bytes"
        listing = await other.get(P, params={"path": "报告/2026"})
        assert listing.json()["files"][0]["rel"] == "报告/2026/raw.bin"
        revision = (await other.get(P)).json()["revision"]
        request = str(uuid4())
        removed = await other.request(
            "DELETE", P, params={"path": "报告"}, json={"requestId": request, "expectedRevision": revision}
        )
        assert removed.status_code == 400 and removed.json()["state"] == "failed"
        request = str(uuid4())
        removed = await other.request(
            "DELETE",
            P,
            params={"path": "报告", "force": "1"},
            json={"requestId": request, "expectedRevision": revision},
        )
        assert removed.status_code == 200 and removed.json()["state"] == "completed", removed.text
        assert (await other.get(created.json()["downloadPath"])).status_code in (400, 404)
        assert (await other.get(P + "/operations/" + request)).json() == removed.json()
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM admin_attachment_entries WHERE deleted_at IS NOT NULL"
                )
            ).fetchone()
        )["n"] == 3
        # Global references are not owned by the actor's F26 media rows.
        await conn.execute("DELETE FROM resource_media_objects WHERE owner_id=%s", (admin,))
        await ResourceMedia(settings).reconcile_orphans(conn)
    digest = created.json()["sha256"]
    assert (settings.file_root / "resource-media" / digest).read_bytes() == b"original\x00bytes"


async def test_legacy_real_cookie_contract_path_sanitize_keep_both_zero_and_private_preview(
    client, admin, app
):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as legacy:
        login = await legacy.post(
            "/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        mkdir = await legacy.post("/api/attachments", data={"action": "mkdir", "name": "报告:一"})
        assert mkdir.json() == {"ok": True, "path": "报告_一"}, mkdir.text
        first = await legacy.post(
            "/api/attachments",
            data={"dir": "报告_一"},
            files={"file": ("source?.html", b"<script>keep-original</script>", "text/html")},
        )
        assert first.json() == {"ok": True, "path": "报告_一/source_.html", "size": 30}, first.text
        conflict = await legacy.post(
            "/api/attachments",
            data={"dir": "报告_一"},
            files={"file": ("source?.html", b"other", "text/html")},
        )
        assert conflict.status_code == 409 and conflict.json()["code"] == "ATTACHMENT_EXISTS"
        second = await legacy.post(
            "/api/attachments",
            data={"dir": "报告_一", "conflict": "keep-both"},
            files={"file": ("source?.html", b"", "text/html")},
        )
        assert second.json() == {"ok": True, "path": "报告_一/source_ (1).html", "size": 0}, second.text
        preview = await legacy.get(
            "/api/attachments", params={"action": "preview", "path": "报告_一/source_.html"}
        )
        assert preview.content == b"<script>keep-original</script>" and preview.headers[
            "content-type"
        ].startswith("text/plain")
        assert (
            "sandbox;" in preview.headers["content-security-policy"]
            and "no-store" in preview.headers["cache-control"]
        )
        directories = await legacy.get("/api/attachments?action=directories")
        assert directories.json() == {"directories": ["", "报告_一"]}
        nofields = await legacy.get("/api/attachments?path=报告_一")
        assert set(nofields.json()) == {"path", "dirs", "files"}
        assert (await legacy.get("/api/attachments", params={"path": "../private"})).status_code == 400
        # The new Web and old Web use different cookies, both hit one domain.
        assert (await client.get(P, params={"path": "报告_一"})).json()["files"]
        original = await legacy.get(
            "/api/attachments", params={"action": "download", "path": "报告_一/source_.html"}
        )
        assert original.content == b"<script>keep-original</script>"
        removed = await legacy.delete("/api/attachments", params={"path": "报告_一", "force": "1"})
        assert removed.status_code == 200 and removed.json() == {"ok": True}
        assert (await legacy.get("/api/attachments?action=directories")).json() == {"directories": [""]}
        assert (
            await legacy.get(
                "/api/attachments", params={"action": "download", "path": "报告_一/source_.html"}
            )
        ).status_code == 400


async def test_non_admin_bearer_csrf_and_stale_revision_never_stage_or_change_global_namespace(
    client, admin, app, settings
):
    assert (
        await client.post(
            P,
            data={"requestId": str(uuid4()), "expectedRevision": "1"},
            files={"file": ("x", b"a", "text/plain")},
            headers={"x-csrf-token": "bad"},
        )
    ).status_code == 403
    assert (await client.get(P, headers={"authorization": "Bearer no-cookie-fallback"})).status_code == 403
    await create_user(settings, "AttachmentUser", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login", json={"login": "AttachmentUser", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get(P)).status_code == 403
        assert (
            await other.post(
                P,
                data={"requestId": str(uuid4()), "expectedRevision": "1"},
                files={"file": ("x", b"a", "text/plain")},
            )
        ).status_code == 403
    one, _ = await upload(client)
    assert one.status_code == 200
    stale, command = await upload(client, "stale.bin", b"not committed", revision=1)
    assert stale.status_code == 409 and stale.json()["state"] == "failed"
    assert (await client.get(P + "/operations/" + command["requestId"])).json() == stale.json()
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_objects")).fetchone())[
            "n"
        ] == 1
