import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.cli import create_user

BASE = "/api/admin/attachment-import"
ATT = "/api/admin/attachments"


def registry(settings, root, private):
    private.mkdir(mode=0o700)
    path = private / "sources.json"
    settings.attachment_import_registry_path = path
    now = datetime.now(UTC)
    info = root.stat()
    document = {
        "version": 1,
        "platformInstance": str(settings.instance_id),
        "sources": [
            {
                "alias": "legacy-global",
                "scope": "admin_shared_attachments",
                "layout": "fire-web-data-attachments-v1",
                "root": str(root),
                "rootIdentity": [info.st_dev, info.st_ino],
                "expectedUid": os.getuid(),
                "migrationWindow": {
                    "notBefore": (now - timedelta(minutes=1)).isoformat(),
                    "expiresAt": (now + timedelta(hours=1)).isoformat(),
                    "state": "active",
                },
                "maxEntries": 1000,
                "maxBytes": 100 * 1024**2,
                "maxDepth": 32,
            }
        ],
    }
    path.write_text(json.dumps(document))
    path.chmod(0o600)
    return path


@pytest_asyncio.fixture
async def source(settings, tmp_path):
    root = tmp_path / "synthetic-old" / "data" / "attachments"
    root.mkdir(parents=True)
    settings.file_root = tmp_path / "platform-files"
    registry(settings, root, tmp_path / "operator")
    return root


async def capture(client, alias="legacy-global", rid=None):
    data = {"requestId": rid or str(uuid4()), "sourceAlias": alias}
    response = await client.post(BASE + "/snapshots", json=data)
    return response, data


async def segment(client, identifier, max_items=32, retry=False, rid=None, plan=None):
    plan = (
        plan
        or (
            await client.post(
                BASE + "/snapshots/" + identifier + "/preview",
                json={"maxItems": max_items, "retryBlocked": retry},
            )
        ).json()
    )
    body = {
        k: plan[k] for k in ["expectedRevision", "manifestRevision", "maxItems", "retryBlocked", "preview"]
    }
    body["requestId"] = rid or str(uuid4())
    response = await client.post(BASE + "/snapshots/" + identifier + "/segments", json=body)
    return response, body


async def apply_all(client, identifier, max_items=32):
    receipts = []
    for _ in range(20):
        before = (await client.get(BASE + "/snapshots/" + identifier)).json()
        if before["pending"] == 0:
            return before, receipts
        result, body = await segment(client, identifier, max_items=max_items)
        assert result.status_code == 200, result.text
        receipts.append((result.json(), body))
    raise AssertionError("bounded synthetic import did not finish")


async def test_capture_preview_small_segments_exact_paths_bytes_empty_file_and_expired_history(
    client, admin, app, settings, source
):
    (source / "Person").mkdir()
    (source / "Person" / "2026").mkdir()
    (source / "Person" / "2026" / "original:one.xml").write_bytes(b"<original>\x00\r\n</original>")
    (source / "zero.bin").write_bytes(b"")
    (source / "assistant-mentioned-in-name.txt").write_bytes(b"F28 global, not excluded by name")
    before = (await client.get(ATT)).json()
    assert before["files"] == [] and before["dirs"] == []
    captured, command = await capture(client)
    assert captured.status_code == 200, captured.text
    payload = captured.json()
    identifier = payload["manifestId"]
    assert (
        payload["state"] == "completed"
        and payload["captureState"] == "sealed"
        and not payload["targetImportCompleted"]
    )
    assert (await client.get(ATT)).json()["files"] == []
    read = (await client.get(BASE + "/snapshots/" + identifier)).json()
    assert read["pending"] == 5 and read["applied"] == 0
    catalog = (await client.get(BASE + "/snapshots")).json()
    assert (
        len(catalog["items"]) == 1
        and catalog["items"][0]["manifestId"] == identifier
        and not catalog["items"][0]["targetImportCompleted"]
    )
    evidence = {i["evidence"]["path"]: i for i in read["items"]}
    assert (
        evidence["zero.bin"]["evidence"]["size"] == 0
        and evidence["zero.bin"]["evidence"]["sha256"] == hashlib.sha256(b"").hexdigest()
    )
    first, _ = await segment(client, identifier, max_items=1)
    assert first.status_code == 200 and not first.json()["targetImportCompleted"]
    done, _receipts = await apply_all(client, identifier)
    assert done["targetImportCompleted"] and done["applied"] == 5
    for path, item in evidence.items():
        if item["evidence"]["kind"] == "file":
            assert (await client.get(ATT, params={"action": "download", "path": path})).content == (
                source / path
            ).read_bytes()
            assert (
                await client.get(
                    BASE + "/snapshots/" + identifier + "/items/" + str(item["ordinal"]) + "/original"
                )
            ).content == (source / path).read_bytes()
    assert len((await client.get(ATT)).json()["files"]) == 2
    document = json.loads(settings.attachment_import_registry_path.read_text())
    document["sources"][0]["migrationWindow"]["expiresAt"] = (
        datetime.now(UTC) - timedelta(seconds=1)
    ).isoformat()
    document["sources"][0]["migrationWindow"]["notBefore"] = (
        datetime.now(UTC) - timedelta(hours=1)
    ).isoformat()
    settings.attachment_import_registry_path.write_text(json.dumps(document))
    root = source.rename(source.with_name("offline-source"))
    again, _ = await capture(client, rid=command["requestId"])
    assert again.json() == payload
    blocked, _ = await capture(client)
    assert blocked.status_code == 409 and "到期" in blocked.text
    assert (await client.get(BASE + "/operations/" + command["requestId"])).json() == payload
    assert (await client.get(BASE + "/snapshots/" + identifier)).json()["targetImportCompleted"]
    assert (
        await client.get(
            BASE + "/snapshots/" + identifier + "/items/" + str(evidence["zero.bin"]["ordinal"]) + "/original"
        )
    ).content == b""
    async with app.state.db.connection() as conn:
        for table in ["resource_files", "resource_media_objects", "legacy_source_heads", "portfolio_records"]:
            assert (await (await conn.execute("SELECT count(*) n FROM " + table)).fetchone())["n"] == 0
    assert root.exists()


async def test_links_overlarge_missing_and_changed_originals_are_blocked_never_zero_complete(
    client, admin, source, app, monkeypatch
):
    outside = source.parent / "foreign.txt"
    outside.write_bytes(b"synthetic outside body")
    (source / "link.txt").symlink_to(outside)
    os.link(outside, source / "hard.txt")
    with (source / "large.bin").open("wb") as f:
        f.truncate(50 * 1024 * 1024 + 1)
    (source / "gone.txt").write_bytes(b"gone")
    (source / "changed.txt").write_bytes(b"original")
    from alcor_api import attachment_source_registry as module

    actual_stat = os.stat
    actual_finish = module.SourceScan.finish

    def missing(path, *args, **kwargs):
        if path == "gone.txt" and kwargs.get("dir_fd") is not None and (source / "gone.txt").exists():
            (source / "gone.txt").unlink()
        return actual_stat(path, *args, **kwargs)

    def changed(scan):
        (source / "changed.txt").write_bytes(b"changed original")
        return actual_finish(scan)

    with monkeypatch.context() as fault:
        fault.setattr(module.os, "stat", missing)
        fault.setattr(module.SourceScan, "finish", changed)
        result, _ = await capture(client)
    assert (
        result.status_code == 200
        and result.json()["captureState"] == "partial"
        and not result.json()["targetImportCompleted"]
    ), result.text
    identifier = result.json()["manifestId"]
    read = (await client.get(BASE + "/snapshots/" + identifier)).json()
    items = {i["evidence"]["path"]: i["evidence"] for i in read["items"]}
    assert items["gone.txt"]["size"] is None
    assert items["large.bin"]["size"] == 50 * 1024 * 1024 + 1
    assert all(item["captureState"] == "blocked" for item in items.values())
    assert read["blocked"] == 5 and not read["targetImportCompleted"]
    applied, _ = await segment(client, identifier)
    assert applied.status_code == 200 and not applied.json()["targetImportCompleted"]
    async with app.state.db.connection() as conn:
        assert not await (
            await conn.execute(
                "SELECT 1 FROM admin_attachment_objects WHERE sha256=%s",
                (hashlib.sha256(outside.read_bytes()).hexdigest(),),
            )
        ).fetchone()


async def test_collision_retry_and_source_identity_alias_cannot_resurrect_target_tombstone(
    client, admin, source, settings
):
    (source / "same.txt").write_bytes(b"old original")
    (source / "other.txt").write_bytes(b"other original")
    revision = (await client.get(ATT)).json()["revision"]
    existing = await client.post(
        ATT,
        data={"action": "upload", "requestId": str(uuid4()), "expectedRevision": str(revision)},
        files={"file": ("same.txt", b"current target")},
    )
    assert existing.status_code == 200
    captured, _ = await capture(client)
    identifier = captured.json()["manifestId"]
    done, _ = await apply_all(client, identifier)
    assert done["blocked"] == 1 and done["applied"] == 1 and not done["targetImportCompleted"]
    assert (
        await client.get(ATT, params={"action": "download", "path": "same.txt"})
    ).content == b"current target"
    revision = (await client.get(ATT)).json()["revision"]
    removed = await client.request(
        "DELETE",
        ATT,
        params={"path": "same.txt"},
        json={"requestId": str(uuid4()), "expectedRevision": revision},
    )
    assert removed.status_code == 200, removed.text
    retried, _ = await segment(client, identifier, retry=True)
    assert retried.status_code == 200 and retried.json()["targetImportCompleted"]
    revision = (await client.get(ATT)).json()["revision"]
    assert (
        await client.request(
            "DELETE",
            ATT,
            params={"path": "same.txt"},
            json={"requestId": str(uuid4()), "expectedRevision": revision},
        )
    ).status_code == 200
    document = json.loads(settings.attachment_import_registry_path.read_text())
    alias = {**document["sources"][0], "alias": "same-physical-root"}
    document["sources"].append(alias)
    settings.attachment_import_registry_path.write_text(json.dumps(document))
    other, _ = await capture(client, alias="same-physical-root")
    new_id = other.json()["manifestId"]
    done, _ = await apply_all(client, new_id)
    assert not done["targetImportCompleted"] and done["blocked"] == 1
    assert (await client.get(ATT, params={"path": ""})).json()["files"][0]["name"] == "other.txt"


async def test_original_uuid_concurrent_cas_explicit_close_and_permissions(
    client, admin, source, app, settings
):
    (source / "one.bin").write_bytes(b"one")
    (source / "two.bin").write_bytes(b"two")
    captured, _ = await capture(client)
    identifier = captured.json()["manifestId"]
    plan = (
        await client.post(
            BASE + "/snapshots/" + identifier + "/preview", json={"maxItems": 1, "retryBlocked": False}
        )
    ).json()
    rid = str(uuid4())
    responses = await asyncio.gather(
        segment(client, identifier, plan=plan, rid=rid), segment(client, identifier, plan=plan, rid=rid)
    )
    assert responses[0][0].json() == responses[1][0].json() and responses[0][0].status_code == 200
    plan = (
        await client.post(
            BASE + "/snapshots/" + identifier + "/preview", json={"maxItems": 1, "retryBlocked": False}
        )
    ).json()
    responses = await asyncio.gather(
        segment(client, identifier, plan=plan), segment(client, identifier, plan=plan)
    )
    assert sorted(r.status_code for r, _ in responses) == [200, 409]
    for r, body in responses:
        assert (await client.get(BASE + "/operations/" + body["requestId"])).json() == r.json()
    close_id = str(uuid4())
    closed = await client.post(BASE + "/operations/" + close_id + "/close", json={"expectedKind": "capture"})
    assert closed.json()["canceled"] and closed.json()["state"] == "failed"
    late, _ = await capture(client, rid=close_id)
    assert late.json() == closed.json()
    assert (
        await client.post(
            BASE + "/snapshots",
            json={"requestId": str(uuid4()), "sourceAlias": "legacy-global", "root": "/not-accepted"},
        )
    ).status_code == 422
    assert (
        await client.get(BASE + "/sources", headers={"authorization": "Bearer no-fallback"})
    ).status_code == 403
    assert (
        await client.post(
            BASE + "/snapshots",
            headers={"x-csrf-token": "wrong"},
            json={"requestId": str(uuid4()), "sourceAlias": "legacy-global"},
        )
    ).status_code == 403
    await create_user(settings, "ImportUser", "SyntheticOther9", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as user:
        login = await user.post(
            "/api/session/login", json={"login": "ImportUser", "password": "SyntheticOther9"}
        )
        user.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await user.get(BASE + "/snapshots/" + identifier)).status_code == 403
        assert (await user.get(BASE + "/snapshots/" + identifier + "/items/0/original")).status_code == 403


async def test_dynamic_finite_window_stops_old_fs_reads_and_budget_or_missing_root_never_seals_empty(
    client, admin, source, settings
):
    import pytest
    from alcor_api.attachment_source_registry import AttachmentSourceError, SourceScan, load_sources

    (source / "one").write_bytes(b"one")
    (source / "two").write_bytes(b"two")
    definition = load_sources(settings)["legacy-global"]
    scan = SourceScan(definition)
    iterator = scan.walk()
    assert next(iterator)[1] == b"one"
    document = json.loads(settings.attachment_import_registry_path.read_text())
    document["sources"][0]["migrationWindow"]["state"] = "revoked"
    settings.attachment_import_registry_path.write_text(json.dumps(document))
    with pytest.raises(AttachmentSourceError, match="revoked"):
        next(iterator)
    scan.finish()
    assert scan.items[0]["captureState"] == "blocked"
    assert (await client.get(BASE + "/sources")).json()["items"][0]["migrationWindow"]["state"] == "revoked"
    denied, _ = await capture(client)
    assert denied.status_code == 409 and "撤销" in denied.text
    document["sources"][0]["migrationWindow"]["state"] = "active"
    document["sources"][0]["maxEntries"] = 1
    settings.attachment_import_registry_path.write_text(json.dumps(document))
    limited, _ = await capture(client)
    assert limited.json()["captureState"] == "partial" and limited.json()["entryCount"] == 1
    identifier = limited.json()["manifestId"]
    done, _ = await apply_all(client, identifier)
    assert done["pending"] == 0 and not done["targetImportCompleted"]
    source.rename(source.with_name("unavailable"))
    missing, _ = await capture(client)
    assert (
        missing.status_code == 200
        and missing.json()["captureState"] == "partial"
        and missing.json()["entryCount"] == 0
        and not missing.json()["targetImportCompleted"]
    )
    document["sources"][0]["migrationWindow"] = None
    settings.attachment_import_registry_path.write_text(json.dumps(document))
    unknown, _ = await capture(client)
    assert unknown.status_code == 409 and "无法核验" in unknown.text
    settings.attachment_import_registry_path.write_text("{broken")
    assert (await client.get(BASE + "/sources")).json()["state"] == "unavailable"
    assert (await client.get(BASE + "/snapshots/" + identifier)).status_code == 200


async def test_expired_offline_source_ready_archive_can_apply_but_uncaptured_rows_stay_blocked(
    client, admin, source, settings
):
    (source / "one").write_bytes(b"one")
    with (source / "oversize").open("wb") as file:
        file.truncate(50 * 1024 * 1024 + 1)
    captured, _ = await capture(client)
    assert captured.json()["captureState"] == "partial"
    identifier = captured.json()["manifestId"]
    plan = (
        await client.post(
            BASE + "/snapshots/" + identifier + "/preview", json={"maxItems": 32, "retryBlocked": False}
        )
    ).json()
    document = json.loads(settings.attachment_import_registry_path.read_text())
    now = datetime.now(UTC)
    document["sources"][0]["migrationWindow"] = {
        "notBefore": (now - timedelta(hours=2)).isoformat(),
        "expiresAt": (now - timedelta(hours=1)).isoformat(),
        "state": "active",
    }
    settings.attachment_import_registry_path.write_text(json.dumps(document))
    source.rename(source.with_name("offline"))
    assert (await client.get(BASE + "/sources")).json()["items"][0]["migrationWindow"]["state"] == "expired"
    assert (
        await client.post(
            BASE + "/snapshots/" + identifier + "/preview", json={"maxItems": 32, "retryBlocked": False}
        )
    ).status_code == 200
    applied, body = await segment(client, identifier, plan=plan)
    assert applied.status_code == 200 and not applied.json()["targetImportCompleted"], applied.text
    read = (await client.get(BASE + "/snapshots/" + identifier)).json()
    assert (
        read["applied"] == 1
        and read["blocked"] == 1
        and read["pending"] == 0
        and not read["targetImportCompleted"]
    )
    assert (await client.get(ATT, params={"action": "download", "path": "one"})).content == b"one"
    blocked = next(i for i in read["items"] if i["evidence"]["path"] == "oversize")
    assert (
        await client.get(
            BASE + "/snapshots/" + identifier + "/items/" + str(blocked["ordinal"]) + "/original"
        )
    ).status_code == 404
    denied, _ = await capture(client)
    assert denied.status_code == 409 and "到期" in denied.text
    assert (await client.get(BASE + "/operations/" + body["requestId"])).json() == applied.json()
