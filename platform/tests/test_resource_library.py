import asyncio
import hashlib
import os
from uuid import uuid4

import httpx
import pytest
from alcor_api.resource_contract import UPLOAD_LIMIT, classify
from resource_test_support import resource_files, setup, unwrap, upload  # noqa:F401
from test_legacy_devices import bearer, grant, register


@pytest.mark.parametrize("version", [0, 1, 2])
async def test_actual_discovery_upload_old_decode_range_and_original_receipts(client, db, settings, version):
    uid, pair, read, base = await setup(client, db, version)
    no_grant = await grant(db, uid, "portfolio.read")
    assert (await client.get(base)).status_code == 401
    assert (await client.get(base, headers=bearer(no_grant))).status_code == 403
    response = await client.get(base, headers=bearer(read))
    contract = unwrap(response, version)
    assert contract["path"] == base and contract["received_files_path"] == base + "/files"
    assert contract["max_upload_bytes"] == 50 * 1024 * 1024 and contract["quota_bytes"] == 1024**3
    assert contract["upload_name_field"] == "name" and contract["automatic_mutation_replay"] is False
    assert contract["read_scope"] == "resources.read" and contract["write_scope"] == "resources.write"
    assert not settings.file_root.exists()
    if version:
        discovery = (await client.get(f"/api/v{version}/auth/config")).json()["data"]["resource_library"]
        assert discovery == {k: v for k, v in contract.items() if k != "usage"}
    response, _ = await upload(client, base, read)
    assert response.status_code == 403
    filename = '原名 "literal%22" e\u0301.txt'
    original = b"\xef\xbb\xbfretained\r\ntext\r\n"
    response, rid = await upload(client, base, pair, filename, original)
    assert response.status_code == 201, response.text
    file = unwrap(response, version) if version else response.json()["result"]
    assert file["name"] == filename and file["sha256"] == hashlib.sha256(original).hexdigest()
    assert (
        file["sizeBytes"] == len(original)
        and file["downloadPath"] == base + "/files/" + file["id"] + "/content"
    )
    assert file["id"].startswith("rlf_") and file["state"] == "ready" and file["revision"] == 1
    assert file["folderId"] is None and file["kind"] == "document" and file["mime"] == "text/plain"
    metadata = await client.get(base + "/files/" + file["id"], headers=bearer(read))
    assert unwrap(metadata, version) == file
    listing = unwrap(await client.get(base + "/files", headers=bearer(read)), version)
    assert listing["items"] == [file] and listing["usage"]["fileCount"] == 1
    body = await client.get(file["downloadPath"], headers=bearer(read))
    assert body.content == original and body.status_code == 200
    assert body.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert (
        body.headers["content-disposition"].startswith("attachment;")
        and "filename*=UTF-8" in body.headers["content-disposition"]
    )
    assert body.headers["accept-ranges"] == "bytes"
    for value, expected in [
        ("bytes=1-3", original[1:4]),
        ("bytes=-4", original[-4:]),
        ("bytes=4-", original[4:]),
        ("bytes=0-9999", original),
    ]:
        chunk = await client.get(file["downloadPath"], headers={**bearer(read), "range": value})
        assert chunk.status_code == 206 and chunk.content == expected
        assert chunk.headers["content-range"].endswith("/" + str(len(original)))
    for value in [
        "bytes=",
        "bytes=-0",
        "bytes=9-2",
        "bytes=9999-",
        "bytes=0-2,4-6",
        "items=0-2",
        "bytes=9007199254740992-",
    ]:
        invalid = await client.get(file["downloadPath"], headers={**bearer(read), "range": value})
        assert invalid.status_code == 416 and invalid.headers["content-range"] == "bytes */" + str(
            len(original)
        )
    duplicate, _ = await upload(client, base, pair, filename, original, rid)
    assert duplicate.status_code == 409
    status = unwrap(await client.get(base + "/uploads/" + rid, headers=bearer(read)), version)
    assert status["state"] == "completed" and status["result"] == file
    assert (await client.get(base + "/deletions/" + rid, headers=bearer(read))).status_code == 404
    response = await client.request(
        "DELETE",
        base + "/files/" + file["id"],
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "revision": 2},
    )
    assert response.status_code == 409
    delete_id = str(uuid4())
    response = await client.request(
        "DELETE",
        base + "/files/" + file["id"],
        headers=bearer(pair),
        json={"requestId": delete_id, "revision": 1},
    )
    assert response.status_code == 200, response.text
    result = unwrap(response, version) if version else response.json()["result"]
    assert (
        result["fileDeleted"] is True and result["usedBytes"] == 0 and result["removedBytes"] == len(original)
    )
    assert (await client.get(file["downloadPath"], headers=bearer(read))).status_code == 404
    assert (
        unwrap(await client.get(base + "/deletions/" + delete_id, headers=bearer(read)), version)["result"]
        == result
    )
    assert unwrap(await client.get(base + "/uploads/" + rid, headers=bearer(read)), version)["result"] == file
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM resource_files WHERE owner_id=%s AND deleted_at IS NOT NULL",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1
    assert (settings.file_root / "resource-media" / file["sha256"]).read_bytes() == original


async def test_owner_scope_origin_csrf_cross_owner_and_private_directory(client, db, settings):
    _uid, pair, _read, base = await setup(client, db)
    response, rid = await upload(client, base, pair)
    file = response.json()["result"]
    other = await register(client, "OtherResources")
    other_pair = await grant(db, other, "portfolio.read resources.read resources.write")
    for route in ["/files/" + file["id"], "/files/" + file["id"] + "/content", "/uploads/" + rid]:
        assert (await client.get(base + route, headers=bearer(other_pair))).status_code == 404
    assert (
        await client.get(base + "/files", headers={**bearer(pair), "origin": "https://untrusted.invalid"})
    ).status_code == 403
    assert (await client.get("/api/resource-media/" + file["sha256"])).status_code == 404
    assert (
        await client.get("/api/media/assets/" + file["sha256"], headers=bearer(other_pair))
    ).status_code in (401, 403, 404)
    login = await client.post(
        "/api/session/login", json={"login": "OtherResources", "password": "SyntheticDevicePassword9"}
    )
    assert login.status_code == 200
    client.headers["x-csrf-token"] = login.json()["csrf"]
    response = await client.post(
        "/api/resource-library/folders",
        json={"requestId": str(uuid4()), "category": "components", "name": "Web folder"},
    )
    assert response.status_code == 201, response.text
    assert (await client.get("/api/resource-library", headers=bearer(pair))).status_code == 403
    assert (
        await client.post(
            "/api/resource-library/folders",
            headers={"x-csrf-token": "invalid"},
            json={"requestId": str(uuid4()), "category": "components", "name": "No"},
        )
    ).status_code == 403
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],)
        )
    assert (await client.get(base + "/files", headers=bearer(pair))).status_code == 401


@pytest.mark.parametrize("version", [0, 1, 2])
async def test_folder_nfc_cas_nonempty_tombstone_and_scope(client, db, version):
    _uid, pair, read, base = await setup(client, db, version)
    body = {"category": "components", "name": "e\u0301"}
    if not version:
        body["requestId"] = str(uuid4())
    result = await client.post(base + "/folders", headers=bearer(pair), json=body)
    assert result.status_code == 201, result.text
    folder = unwrap(result, version) if version else result.json()["result"]
    assert folder["name"] == "é" and folder["parentId"] is None
    assert result.headers["x-alcor-resource-request-id"]
    duplicate = await client.post(
        base + "/folders",
        headers=bearer(pair),
        json={**body, **({"requestId": str(uuid4())} if not version else {})},
    )
    assert duplicate.status_code == 409
    response, _ = await upload(
        client, base, pair, folderId=folder["id"], **({"folderRevision": "1"} if not version else {})
    )
    assert response.status_code == 201, response.text
    listed = unwrap(
        await client.get(base + "/folders", headers=bearer(read), params={"category": "components"}), version
    )
    assert listed["items"][0]["revision"] == 2
    deletion = {"revision": 2}
    if not version:
        deletion["requestId"] = str(uuid4())
    assert (
        await client.request("DELETE", base + "/folders/" + folder["id"], headers=bearer(pair), json=deletion)
    ).status_code == 409
    file = unwrap(response, version) if version else response.json()["result"]
    await client.request(
        "DELETE",
        base + "/files/" + file["id"],
        headers=bearer(pair),
        json={"revision": 1, "requestId": str(uuid4())},
    )
    deletion["revision"] = 3
    if not version:
        deletion["requestId"] = str(uuid4())
    assert (
        await client.request("DELETE", base + "/folders/" + folder["id"], headers=bearer(pair), json=deletion)
    ).status_code == 200
    assert (
        unwrap(
            await client.get(base + "/folders", headers=bearer(read), params={"category": "components"}),
            version,
        )["items"]
        == []
    )
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT deleted_at FROM resource_folders WHERE id=%s", (folder["id"],))
            ).fetchone()
        )["deleted_at"] is not None
    replacement = {**body, **({"requestId": str(uuid4())} if not version else {})}
    assert (await client.post(base + "/folders", headers=bearer(pair), json=replacement)).status_code == 201


async def test_concurrent_uuid_and_quota_deduplicate_only_physical_bytes(client, db, settings):
    uid, pair, read, base = await setup(client, db)
    rid = str(uuid4())
    responses = await asyncio.gather(*(upload(client, base, pair, rid=rid) for _ in range(2)))
    assert sorted(r[0].status_code for r in responses) == [201, 409]
    one, _ = await upload(client, base, pair)
    assert one.status_code == 201
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM resource_media_objects WHERE owner_id=%s", (uid,)
                )
            ).fetchone()
        )["n"] == 1
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM resource_files WHERE owner_id=%s", (uid,))
            ).fetchone()
        )["n"] == 2
    assert len(list((settings.file_root / "resource-media").iterdir())) == 1
    usage = (await client.get(base, headers=bearer(read))).json()["usage"]
    assert usage["fileCount"] == 2 and usage["usedBytes"] == 2 * len(b"original\r\n")
    other = await register(client, "SameBytesOther")
    other_pair = await grant(db, other, "portfolio.read resources.read resources.write")
    assert (await upload(client, base, other_pair))[0].status_code == 201
    assert len(list((settings.file_root / "resource-media").iterdir())) == 1
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 2


async def test_canonical_rename_move_original_snapshot_receipt_and_cycle_cas(client, db):
    _uid, pair, read, base = await setup(client, db)

    async def folder(name, **kw):
        r = await client.post(
            base + "/folders",
            headers=bearer(pair),
            json={"requestId": str(uuid4()), "category": "components", "name": name, **kw},
        )
        assert r.status_code == 201, r.text
        return r.json()["result"]

    first = await folder("first")
    second = await folder("second")
    child = await folder("child", parentId=first["id"], parentRevision=1)
    cycle = await client.patch(
        base + "/folders/" + first["id"],
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "revision": 2, "parentId": child["id"], "parentRevision": 1},
    )
    assert cycle.status_code == 409
    response, original_id = await upload(client, base, pair)
    file = response.json()["result"]
    move_id = str(uuid4())
    moved = await client.patch(
        base + "/files/" + file["id"],
        headers=bearer(pair),
        json={
            "requestId": move_id,
            "revision": 1,
            "folderId": second["id"],
            "folderRevision": 1,
            "name": "new.txt",
        },
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["result"]["revision"] == 2 and moved.json()["result"]["folderId"] == second["id"]
    old = (await client.get(base + "/uploads/" + original_id, headers=bearer(read))).json()["result"]
    assert old == file and old["name"] == "original.txt" and old["folderId"] is None
    assert (await client.get(old["downloadPath"], headers=bearer(read))).content == b"original\r\n"
    stale = await client.patch(
        base + "/files/" + file["id"],
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "revision": 1, "name": "overwrite.txt"},
    )
    assert stale.status_code == 409
    sibling = await folder("occupied")
    collision = await client.patch(
        base + "/folders/" + sibling["id"],
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "revision": 1, "name": "first"},
    )
    assert collision.status_code == 409
    cross = await register(client, "CrossFolder")
    cross_pair = await grant(db, cross, "portfolio.read resources.read resources.write")
    assert (
        await client.patch(
            base + "/files/" + file["id"],
            headers=bearer(cross_pair),
            json={"requestId": str(uuid4()), "revision": 2, "name": "steal.txt"},
        )
    ).status_code == 404


async def test_keyset_cursors_bind_owner_filters_sort_and_unique_query(client, db):
    _uid, pair, read, base = await setup(client, db)
    for filename in ["b.txt", "a.txt", "b.txt", "é.txt"]:
        assert (await upload(client, base, pair, filename))[0].status_code == 201
    seen = []
    cursor = None
    while True:
        params = {"limit": "1", "sort": "name", "direction": "asc"}
        if cursor:
            params["cursor"] = cursor
        response = await client.get(base + "/files", headers=bearer(read), params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        seen.extend(page["items"])
        cursor = page["nextCursor"]
        if not cursor:
            break
    assert [f["name"] for f in seen] == ["a.txt", "b.txt", "b.txt", "é.txt"] and len(
        {f["id"] for f in seen}
    ) == 4
    page = (await client.get(base + "/files", headers=bearer(read), params={"limit": 1})).json()
    cursor = page["nextCursor"]
    for params in [
        {"cursor": cursor, "kind": "document"},
        {"cursor": cursor, "sort": "name"},
        {"cursor": cursor + ".bad"},
        {"limit": 0},
        {"limit": 101},
        {"folderId": ""},
        {"unknown": "1"},
    ]:
        response = await client.get(base + "/files", headers=bearer(read), params=params)
        assert response.status_code in (400, 404), response.text
    assert (
        await client.get(base + "/files?kind=document&kind=document", headers=bearer(read))
    ).status_code == 400
    other = await register(client, "CursorOther")
    other_pair = await grant(db, other, "portfolio.read resources.read")
    assert (
        await client.get(base + "/files", headers=bearer(other_pair), params={"cursor": cursor})
    ).status_code == 400


async def test_audit_fault_rolls_back_index_and_receipt_not_original_bytes(client, db, settings):
    _uid, pair, read, base = await setup(client, db)
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_resource_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='resource.upload' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_resource_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_resource_audit()"
        )
    response, rid = await upload(client, base, pair)
    assert response.status_code == 503, response.text
    assert (await client.get(base + "/uploads/" + rid, headers=bearer(read))).status_code == 404
    assert (await client.get(base, headers=bearer(read))).json()["usage"]["fileCount"] == 0
    assert len(list((settings.file_root / "resource-media").iterdir())) == 1
    assert (await client.get(base + "/files", headers=bearer(read))).json()["items"] == []
    async with db.connection() as conn, conn.transaction():
        from alcor_api.resource_media import ResourceMedia

        assert await ResourceMedia(settings).reconcile_orphans(conn) == 0
        path = next((settings.file_root / "resource-media").iterdir())
        os.utime(path, (1, 1))
        assert await ResourceMedia(settings).reconcile_orphans(conn) == 1
    assert not list((settings.file_root / "resource-media").iterdir())


async def test_identity_revoked_while_multipart_arrives_cannot_publish(client, db):
    _uid, pair, read, base = await setup(client, db)
    rid = str(uuid4())
    request = client.build_request(
        "POST",
        base + "/files",
        headers=bearer(pair),
        data={"requestId": rid, "category": "components", "name": "late.txt"},
        files={"file": ("x", b"synthetic", "application/octet-stream")},
    )
    content = request.read()

    class Late(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield content[:100]
            async with db.connection() as conn:
                await conn.execute(
                    "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s",
                    (pair["grant_id"],),
                )
            yield content[100:]

    request.stream = Late()
    response = await client.send(request)
    assert response.status_code == 401, response.text
    assert (await client.get(base + "/uploads/" + rid, headers=bearer(read))).status_code == 404
    assert (await client.get(base, headers=bearer(read))).json()["usage"]["fileCount"] == 0


async def test_global_pg_upload_slots_are_shared_and_released(app):
    service = app.state.resource_library
    async with service.upload_slot(), service.upload_slot():
        with pytest.raises(Exception) as caught:
            async with service.upload_slot():
                pass
        assert caught.value.status_code == 429
    async with service.upload_slot():
        pass


async def test_exact_50mib_upload_logical_quota_and_no_64k_accidental_limit(client, db):
    uid, pair, read, base = await setup(client, db)
    original = b"x" * UPLOAD_LIMIT
    response, _rid = await upload(client, base, pair, "binary.dat", original)
    assert response.status_code == 201, response.text
    file = response.json()["result"]
    assert (
        await client.get(file["downloadPath"], headers={**bearer(read), "range": "bytes=-3"})
    ).content == b"xxx"
    async with db.connection() as conn:
        for _ in range(19):
            await conn.execute(
                "INSERT INTO resource_files(id,owner_id,category,name,kind,mime,size_bytes,sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    "rlf_" + uuid4().hex,
                    uid,
                    "components",
                    "copy.dat",
                    "other",
                    "application/octet-stream",
                    UPLOAD_LIMIT,
                    file["sha256"],
                ),
            )
    response, _ = await upload(client, base, pair, "over-quota.dat", b"y" * (25 * 1024 * 1024))
    assert response.status_code == 409, response.text
    assert (await client.get(base, headers=bearer(read))).json()["usage"]["fileCount"] == 20
    assert (await upload(client, base, pair, "empty.dat", b""))[0].status_code == 413
    assert (await upload(client, base, pair, "oversize.dat", original + b"x"))[0].status_code == 413


@pytest.mark.parametrize(
    "name,raw,kind",
    [
        ("x.jpg", b"\xff\xd8\xffx", "image"),
        ("x.png", b"\x89PNG\r\n\x1a\nx", "image"),
        ("x.gif", b"GIF89ax", "image"),
        ("x.webp", b"RIFFxxxxWEBPx", "image"),
        ("x.heic", b"xxxxftypheic", "image"),
        ("x.heif", b"xxxxftypmif1", "image"),
        ("x.mp4", b"xxxxftypxxxx", "video"),
        ("x.mov", b"xxxxftypxxxx", "video"),
        ("x.webm", b"\x1aE\xdf\xa3x", "video"),
        ("x.mp3", b"ID3x", "audio"),
        ("x.m4a", b"xxxxftypxxxx", "audio"),
        ("x.aac", b"\xff\xf1", "audio"),
        ("x.wav", b"RIFFxxxxWAVEx", "audio"),
        ("x.ogg", b"OggSx", "audio"),
        ("x.flac", b"fLaCx", "audio"),
        ("x.pdf", b"%PDF-x", "document"),
        ("x.txt", b"text\r\n", "document"),
        ("x.md", b"# Hi", "document"),
        ("x.csv", b"a,b\n", "document"),
        ("x.json", b'{"x":0}', "document"),
        ("x.docx", b"PK\x03\x04x", "document"),
        ("x.xlsx", b"PK\x05\x06x", "document"),
        ("x.pptx", b"PK\x07\x08x", "document"),
        ("x.zip", b"PK\x03\x04x", "archive"),
        ("x.gz", b"\x1f\x8bx", "archive"),
        ("x.7z", b"7z\xbc\xaf\x27\x1cx", "archive"),
        ("x.rar", b"Rar!\x1a\x07x", "archive"),
        ("x.unknown", b"<script>original</script>\x00", "other"),
    ],
)
def test_legacy_format_signature_vectors_preserve_original(name, raw, kind):
    original = bytes(raw)
    assert classify(raw, name, "components")[0] == kind and raw == original


@pytest.mark.parametrize(
    "name,raw,cat",
    [
        ("fake.png", b"not png", "components"),
        ("bad.txt", b"\xff", "components"),
        ("bad.txt", b"a\x00b", "components"),
        ("bad.json", b"NaN", "components"),
        ("bad.json", b"{", "components"),
        ("x.txt", b"hi", "media"),
        ("x.html", b"<html>", "media"),
    ],
)
def test_legacy_mismatch_and_media_rules(name, raw, cat):
    with pytest.raises(Exception) as caught:
        classify(raw, name, cat)
    assert caught.value.status_code == 415


async def test_directory_depth_count_limits_and_database_guards(client, db):
    uid, pair, _read, base = await setup(client, db)
    parent = None
    for depth in range(1, 9):
        body = {"requestId": str(uuid4()), "category": "components", "name": str(depth)}
        if parent:
            body.update(parentId=parent, parentRevision=1)
        response = await client.post(base + "/folders", headers=bearer(pair), json=body)
        assert response.status_code == 201, response.text
        parent = response.json()["result"]["id"]
    too_deep = await client.post(
        base + "/folders",
        headers=bearer(pair),
        json={
            "requestId": str(uuid4()),
            "category": "components",
            "name": "9",
            "parentId": parent,
            "parentRevision": 1,
        },
    )
    assert too_deep.status_code == 400
    async with db.connection() as conn:
        for n in range(120):
            await conn.execute(
                "INSERT INTO resource_folders(id,owner_id,category,name) VALUES(%s,%s,%s,%s)",
                ("rld_" + uuid4().hex, uid, "components", "root-" + str(n)),
            )
    too_many = await client.post(
        base + "/folders",
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "category": "components", "name": "129"},
    )
    assert too_many.status_code == 409
    import psycopg

    async with db.connection() as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            await conn.execute(
                "INSERT INTO resource_folders(id,owner_id,category,name) VALUES(%s,%s,%s,%s)",
                ("rld_" + uuid4().hex, uid, "components", "bypass"),
            )
    response, rid = await upload(client, base, pair)
    file = response.json()["result"]
    async with db.connection() as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            await conn.execute("UPDATE resource_files SET sha256=%s WHERE id=%s", ("a" * 64, file["id"]))
        with pytest.raises(psycopg.errors.RaiseException):
            await conn.execute(
                "UPDATE resource_operation_receipts SET result='{}' WHERE owner_id=%s AND request_id=%s",
                (uid, rid),
            )


async def test_private_symlink_hardlink_corruption_and_get_never_reconciles(client, db, settings, tmp_path):
    _uid, pair, read, base = await setup(client, db)
    response, rid = await upload(client, base, pair)
    file = response.json()["result"]
    path = settings.file_root / "resource-media" / file["sha256"]
    original = path.read_bytes()
    other = tmp_path / "same-original"
    os.link(path, other)
    assert (await client.get(file["downloadPath"], headers=bearer(read))).status_code == 503
    other.unlink()
    path.unlink()
    other.write_bytes(original)
    other.chmod(0o600)
    path.symlink_to(other)
    assert (await client.get(file["downloadPath"], headers=bearer(read))).status_code == 503
    path.unlink()
    path.write_bytes(original)
    path.chmod(0o600)
    orphan = path.parent / ("e" * 64)
    orphan.write_bytes(b"never a committed original")
    orphan.chmod(0o600)
    os.utime(orphan, (1, 1))
    before = orphan.stat().st_mtime_ns
    for route in ["", "/files", "/uploads/" + rid]:
        assert (await client.get(base + route, headers=bearer(read))).status_code == 200
    assert orphan.exists() and orphan.stat().st_mtime_ns == before
    path.chmod(0o644)
    assert (await client.get(file["downloadPath"], headers=bearer(read))).status_code == 503


async def test_fsync_failure_never_publishes_and_reuse_requires_fresh_file_fsync(
    client, db, settings, monkeypatch
):
    import stat

    from alcor_api import resource_media

    _uid, pair, read, base = await setup(client, db)
    fsync = resource_media.os.fsync
    calls = []
    fail = True

    def observed(descriptor):
        nonlocal fail
        regular = stat.S_ISREG(os.fstat(descriptor).st_mode)
        calls.append("file" if regular else "directory")
        if fail and regular:
            fail = False
            raise OSError("synthetic fsync fault")
        return fsync(descriptor)

    monkeypatch.setattr(resource_media.os, "fsync", observed)
    response, rid = await upload(client, base, pair)
    assert response.status_code == 503
    assert (await client.get(base + "/uploads/" + rid, headers=bearer(read))).status_code == 404
    assert (await client.get(base, headers=bearer(read))).json()["usage"]["fileCount"] == 0
    calls.clear()
    response, _ = await upload(client, base, pair, "another.txt")
    assert response.status_code == 201, response.text
    assert calls[:2] == ["file", "directory"]


async def test_queries_shapes_and_body_budget_stay_narrow(client, db):
    _uid, pair, read, base = await setup(client, db)
    for fields in [
        {"requestId": str(uuid4()), "category": "components", "name": "x", "unknown": 1},
        {
            "requestId": str(uuid4()),
            "category": "components",
            "name": "x",
            "parentId": None,
            "parentRevision": 1,
        },
        {"requestId": str(uuid4()), "category": "components", "name": "../x"},
        {"requestId": str(uuid4()), "category": "components", "name": " x"},
    ]:
        response = await client.post(base + "/folders", headers=bearer(pair), json=fields)
        assert response.status_code == 400, response.text
    response = await client.post(
        base + "/folders",
        headers={**bearer(pair), "content-type": "application/json"},
        content='{"name":"x","name":"y"}',
    )
    assert response.status_code == 400
    assert (
        await client.get(base + "/files", headers=bearer(read), params={"limit": "9" * 5000})
    ).status_code == 400
    assert (await client.get("/api/v3/resource-library", headers=bearer(pair))).status_code == 404
    assert (
        await client.patch("/api/v1/resource-library/files/rlf_" + "0" * 32, headers=bearer(pair), json={})
    ).status_code == 405
    assert (
        await client.post(
            base + "/folders",
            headers={**bearer(pair), "content-type": "application/json"},
            content=b"x" * 4097,
        )
    ).status_code == 413
    response = await client.post(
        "/api/session/login", headers={"content-type": "application/json"}, content=b"x" * 65537
    )
    assert response.status_code == 413


async def test_maximum_5000_files_is_logical_and_database_enforced(client, db):
    uid, pair, read, base = await setup(client, db)
    response, _ = await upload(client, base, pair)
    file = response.json()["result"]
    async with db.connection() as conn:
        await conn.execute(
            """INSERT INTO resource_files(id,owner_id,category,name,kind,mime,size_bytes,sha256)
            SELECT 'rlf_'||replace(gen_random_uuid()::text,'-',''),%s,'components','copy.txt','document','text/plain',%s,%s
            FROM generate_series(1,4999)""",
            (uid, file["sizeBytes"], file["sha256"]),
        )
    response, _ = await upload(client, base, pair)
    assert response.status_code == 409, response.text
    assert (await client.get(base, headers=bearer(read))).json()["usage"]["fileCount"] == 5000
    import psycopg

    async with db.connection() as conn:
        with pytest.raises(psycopg.errors.RaiseException):
            await conn.execute(
                """INSERT INTO resource_files(id,owner_id,category,name,kind,mime,size_bytes,sha256)
                VALUES(%s,%s,'components','bypass.txt','document','text/plain',%s,%s)""",
                ("rlf_" + uuid4().hex, uid, file["sizeBytes"], file["sha256"]),
            )


async def test_legacy_folder_nfc_expansion_is_preserved_then_can_move(client, db):
    _uid, pair, _read, base = await setup(client, db)
    filename = "\u0344" * 120
    created = await client.post(
        "/api/v1/resource-library/folders",
        headers=bearer(pair),
        json={"category": "components", "name": filename},
    )
    assert created.status_code == 201, created.text
    folder = created.json()["data"]
    import unicodedata

    assert folder["name"] == unicodedata.normalize("NFC", filename)
    changed = await client.patch(
        base + "/folders/" + folder["id"],
        headers=bearer(pair),
        json={"requestId": str(uuid4()), "revision": 1, "parentId": None},
    )
    assert changed.status_code == 200 and changed.json()["result"]["name"] == folder["name"]


async def test_hidden_file_and_ecmascript_name_bytes_through_actual_pg(client, db):
    _uid, pair, read, base = await setup(client, db)
    for filename, raw in [(".png", b"not an image"), ("\u0085permitted.dat", b"\x00original")]:
        response, _ = await upload(client, base, pair, filename, raw)
        assert response.status_code == 201, response.text
        file = response.json()["result"]
        assert (
            file["name"] == filename
            and file["kind"] == "other"
            and file["mime"] == "application/octet-stream"
        )
        assert (await client.get(file["downloadPath"], headers=bearer(read))).content == raw
    response, _ = await upload(client, base, pair, "\ufeffforbidden.txt", b"original")
    assert response.status_code == 400


@pytest.mark.parametrize(
    "table,permission",
    [
        ("resource_cursor_key", "SELECT"),
        ("resource_media_objects", "INSERT"),
        ("resource_folders", "UPDATE"),
        ("resource_files", "DELETE"),
        ("resource_operation_receipts", "INSERT"),
    ],
)
async def test_connection_missing_required_resource_permission_is_never_applied(
    settings, client, admin, db, table, permission
):
    from psycopg import sql
    from test_connections import request_data, values

    role = "resource_limited_" + uuid4().hex
    async with db.connection() as conn:
        await conn.execute(sql.SQL("CREATE ROLE {} LOGIN").format(sql.Identifier(role)))
        await conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(role)))
        await conn.execute(
            sql.SQL("GRANT ALL ON ALL TABLES IN SCHEMA public TO {}").format(sql.Identifier(role))
        )
        await conn.execute(
            sql.SQL("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO {}").format(sql.Identifier(role))
        )
        await conn.execute(
            sql.SQL("REVOKE {} ON {} FROM {}").format(
                sql.SQL(permission), sql.Identifier(table), sql.Identifier(role)
            )
        )
    try:
        response = await client.put(
            "/api/connections/postgresql", json=await request_data(client, settings, username=role)
        )
        assert response.status_code == 200 and response.json()["status"] == "failed", response.text
        assert "权限" in response.json()["message"]
        assert (await values(client))["revision"] is None
        assert (await client.get("/api/session")).status_code == 200
    finally:
        async with db.connection() as conn:
            await conn.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            await conn.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
