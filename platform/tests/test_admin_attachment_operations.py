import asyncio
import json
import posixpath
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from test_admin_attachments import (
    P,
    attachment_files,  # noqa: F401 -- imported autouse fixture
    upload,
)

GOLDEN = json.loads(Path(__file__).with_name("attachment-operations-golden.json").read_text())


async def command(client, action, revision=None, request_id=None, **fields):
    revision = revision if revision is not None else (await client.get(P)).json()["revision"]
    body = {"action": action, "requestId": request_id or str(uuid4()), "expectedRevision": revision, **fields}
    return await client.post(P, json=body), body


async def active_tree(client):
    directories = (await client.get(P, params={"action": "directories"})).json()["directories"]
    files = {}
    for directory in directories:
        listing = (await client.get(P, params={"path": directory})).json()
        for row in listing["files"]:
            result = await client.get(P, params={"action": "download", "path": row["rel"]})
            assert result.status_code == 200, result.text
            files[row["rel"]] = result.content.hex()
    return {"directories": sorted(filter(None, directories)), "files": files}


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda case: case["name"])
async def test_actual_legacy_operation_golden_trees_and_statuses(client, admin, app, case):
    for directory in case["dirs"]:
        result, _ = await command(
            client, "mkdir", dir=posixpath.dirname(directory), name=posixpath.basename(directory)
        )
        assert result.status_code == 200, result.text
    for path, content in case["files"].items():
        result, _ = await upload(
            client, posixpath.basename(path), content.encode(), directory=posixpath.dirname(path)
        )
        assert result.status_code == 200, result.text
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as legacy:
        login = await legacy.post(
            "/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        body = {key: case[key] for key in ("action", "source", "targetDir", "conflict") if key in case}
        if "nameInput" in case:
            body["name"] = case["nameInput"]
        result = await legacy.post("/api/attachments", data=body)
        assert result.status_code == case["expected"]["status"], result.text
        assert result.json() == case["expected"]["body"]
        assert await active_tree(client) == case["expected"]["tree"]


async def test_rename_copy_original_uuid_versions_independent_delete_and_no_byte_double_write(
    client, admin, app
):
    original, _ = await upload(client, "source.bin", b"immutable\x00original")
    assert original.status_code == 200, original.text
    renamed, body = await command(client, "rename", source="source.bin", name="new?.txt")
    assert renamed.status_code == 200 and renamed.json()["result"] == {"ok": True, "path": "new_.txt"}, (
        renamed.text
    )
    assert renamed.json()["fileVersion"] != original.json()["fileVersion"]
    assert (await client.get(original.json()["downloadPath"])).content == b"immutable\x00original"
    current = await client.get(renamed.json()["downloadPath"])
    assert (
        current.content == b"immutable\x00original" and "new_.txt" in current.headers["content-disposition"]
    )
    copied, _ = await command(client, "copy", source="new_.txt", targetDir="copies")
    assert copied.status_code == 200, copied.text
    moved, _ = await command(client, "move", source="new_.txt", targetDir="moved")
    assert moved.status_code == 200, moved.text
    assert (await client.post(P, json=body)).json() == renamed.json()
    assert (await client.post(P, json={**body, "name": "another"})).status_code == 409
    revision = (await client.get(P)).json()["revision"]
    deleted = await client.request(
        "DELETE",
        P,
        params={"path": "moved/new_.txt"},
        json={"requestId": str(uuid4()), "expectedRevision": revision},
    )
    assert deleted.status_code == 200
    assert (await client.get(original.json()["downloadPath"])).status_code == 400
    assert (await client.get(copied.json()["downloadPath"])).content == b"immutable\x00original"
    for receipt in (renamed, copied, moved):
        assert (await client.get(P + "/operations/" + receipt.json()["requestId"])).json() == receipt.json()
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_objects")).fetchone())[
            "n"
        ] == 1
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 0


async def test_real_concurrent_scope_cas_commits_once_and_persists_loser_original_uuid(client, admin, app):
    first, _ = await upload(client, "a.bin", b"first")
    second, _ = await upload(client, "b.bin", b"second")
    assert first.status_code == second.status_code == 200
    revision = (await client.get(P)).json()["revision"]
    attempts = await asyncio.gather(
        command(client, "rename", revision=revision, source="a.bin", name="renamed.bin"),
        command(client, "move", revision=revision, source="b.bin", targetDir="target"),
    )
    assert sorted(response.status_code for response, _ in attempts) == [200, 409]
    assert (await client.get(P)).json()["revision"] == revision + 1
    for response, body in attempts:
        assert (await client.get(P + "/operations/" + body["requestId"])).json() == response.json()
        assert (await client.post(P, json=body)).json() == response.json()
    assert (await client.get(first.json()["downloadPath"])).content == b"first"
    assert (await client.get(second.json()["downloadPath"])).content == b"second"
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM admin_attachment_operations WHERE result->>'state'='failed'"
                )
            ).fetchone()
        )["n"] == 1


async def test_missing_original_and_ancestor_replacement_never_erase_source_or_create_target(
    client, admin, app, settings
):
    uploaded, _ = await upload(client, "parent", b"original", directory="parent")
    assert uploaded.status_code == 200, uploaded.text
    before = await active_tree(client)
    refused, _ = await command(client, "move", source="parent/parent", targetDir="", conflict="replace")
    assert refused.status_code == 400 and refused.json()["state"] == "failed", refused.text
    assert await active_tree(client) == before
    digest = uploaded.json()["sha256"]
    path = settings.file_root / "resource-media" / digest
    path.unlink()
    revision = (await client.get(P)).json()["revision"]
    failed, body = await command(client, "copy", source="parent", targetDir="new/parent")
    assert failed.status_code == 503 and failed.json()["state"] == "failed", failed.text
    directories = (await client.get(P, params={"action": "directories"})).json()["directories"]
    assert directories == ["", "parent"]
    assert (await client.get(P)).json()["revision"] == revision
    assert (await client.get(P + "/operations/" + body["requestId"])).json() == failed.json()
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM admin_attachment_entries WHERE deleted_at IS NOT NULL"
                )
            ).fetchone()
        )["n"] == 0
